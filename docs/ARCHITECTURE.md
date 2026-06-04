# Architecture

This document explains how `webgpu-worker` is put together: the thread split,
the Comlink bridge, the wgpu renderer, and the build pipeline. File paths are
relative to the repository root, and key functions and types are named so you
can grep for them.

## The one idea

A from-scratch [wgpu](https://wgpu.rs) renderer runs inside a **web worker**,
never on the browser's main thread. The worker owns an `OffscreenCanvas`, drives
the render loop with `requestAnimationFrame`, and draws a lit, spinning cube
through WebGPU. The main thread is a plain **TypeScript** page that transfers the
canvas to the worker once, forwards input events, and displays stats. There is no
`winit` and no engine.

The payoff is the "Jam main thread for 3 s" button: it busy-loops the main
thread, and the cube keeps spinning at full framerate because the render loop
lives on another thread.

This is the raw-wgpu counterpart to
[bevy-worker](https://github.com/matthewjberger/bevy-worker) (same worker
architecture and build, but a full Bevy engine instead of a hand-written
renderer).
[webgpu-worker-leptos](https://github.com/matthewjberger/webgpu-worker-leptos) is
this same renderer with the TypeScript page and Comlink replaced by an all-Rust
[Leptos](https://leptos.dev) frontend and a shared `protocol` crate. The worker
approach follows Nick Babcock's
[write-up on running a Bevy app off the main thread](https://nickb.dev/blog/a-bevy-app-entirely-off-the-main-thread/).

## Layout

A single Rust crate plus a TypeScript web frontend — not a workspace.

| Path | Runs on | Role |
|---|---|---|
| `src/lib.rs` | worker | The whole renderer: `WgpuApp` wasm-bindgen handle, `Gpu`, `Scene`, `OrbitCamera`, inline WGSL, picking. |
| `web/src/worker.ts` | worker | Bootstraps the wasm module, drives `app.update()` with `requestAnimationFrame`, exposes the worker API over Comlink. |
| `web/src/main.ts` | main thread | Transfers the canvas, spawns the worker, captures input, displays stats. |
| `web/index.html` | main thread | The page: placeholder canvas + control panel (plain HTML/CSS). |

The Rust crate is `crate-type = ["cdylib", "rlib"]` and depends on `wgpu`,
`bytemuck`, and `nalgebra-glm`. It compiles to one wasm module; `wasm-bindgen`
generates the JS glue and TypeScript types (`tsify-next` derives the shared
structs) that `worker.ts` imports.

## The thread split

```
┌─────────────────────────── MAIN THREAD ──────────────────────────────┐
│  TypeScript page  (web/)                                              │
│                                                                       │
│   web/index.html   placeholder <canvas> + control panel              │
│   web/src/main.ts  transfer canvas, spawn worker, capture input      │
│                                                                       │
│   transferControlToOffscreen()  ── OffscreenCanvas ──┐               │
│   Comlink.wrap<WorkerApi>(worker)                     │               │
│   game.orbit(), game.zoom(), game.pick() ────────────┼──────────────▶ │
│   sink.onReady(), sink.onStats()         ◀───────────┘               │
└───────────────────────────────────────────────────────────────────────┘
                              │  Comlink RPC over postMessage
                              ▼
┌─────────────────────────── WEB WORKER ───────────────────────────────┐
│  web/src/worker.ts                                                    │
│   • init({ module_or_path }) — explicit wasm-bindgen init            │
│   • await WgpuApp.create(canvas, size)                                │
│   • requestAnimationFrame(update) → app.update()                     │
│   • Comlink.expose({ createGame })                                    │
│                                                                       │
│  src/lib.rs  (the wgpu renderer, all in the worker)                   │
│   • Gpu: instance, surface, adapter, device, queue                    │
│   • Scene: cube, uniform buffer, pipeline, inline WGSL                │
│   • surface straight from wgpu::SurfaceTarget::OffscreenCanvas        │
└───────────────────────────────────────────────────────────────────────┘
```

After the one-time canvas transfer, the main thread can never draw to the canvas
again. From then on the two sides communicate only through Comlink.

## The Comlink bridge

[Comlink](https://github.com/GoogleChromeLabs/comlink) turns method calls into
async `postMessage` round-trips, so there is no hand-written message enum — the
contract is the TypeScript interfaces in `web/src/worker.ts`. There are two
directions:

**Page → worker** is the `GameApi` (also `WorkerApi.createGame`). The worker
`expose`s these and the page `wrap`s them, so each call becomes a
Promise-returning RPC:

```ts
type GameApi = {
  resize, setSpeed, setColor, orbit, zoom,   // one-way fire-and-forget in practice
  pick: (x, y) => PickResult | undefined,     // request/response (awaited)
  stats: () => Stats,                         // request/response (the jam poll)
  context: () => string,                      // request/response (one-time)
};
```

Each maps directly onto a `#[wasm_bindgen]` method on `WgpuApp`
(`resize`, `set_speed`, `set_color`, `orbit`, `zoom`, `pick`, `stats`,
`context`).

**Worker → page** is the `EventSink`. The page builds it and passes it into
`createGame` wrapped in `Comlink.proxy`, so the worker holds a callable handle
and can push up:

```ts
type EventSink = {
  onReady: (info: AdapterInfo) => void;   // fires once, when the GPU adapter exists
  onStats: (stats: Stats) => void;        // streamed, throttled to every 250 ms
};
```

`onReady` carries the GPU adapter name and backend that only the worker knows
(the panel's "renderer" line). `onStats` makes the fps/frame readout push-driven
instead of polled. The jam button still *pulls* `stats()` on demand so it gets an
exact before/after count.

The shared data types (`CanvasSize`, `Stats`, `AdapterInfo`, `PickResult`) are
Rust structs in `src/lib.rs` deriving `tsify_next::Tsify`, so `wasm-bindgen`
emits matching TypeScript definitions and neither side hand-writes the shapes.

## Startup handshake

1. **`main.ts` runs.** It sizes the canvas by `devicePixelRatio`, calls
   `canvas.transferControlToOffscreen()`, and spawns the worker as an ES module
   (`new Worker(new URL("./worker.ts", …), { type: "module" })`). It wraps the
   worker with `Comlink.wrap<WorkerApi>`.
2. **`worker.ts` starts wasm init early but does not block.** At module top it
   kicks off `const initialized = init({ module_or_path: wasmPath })`, where
   `wasmPath` comes from a Vite `?url` import (no `vite-plugin-wasm`).
3. **The page calls `createGame`**, passing the transferred canvas
   (`Comlink.transfer(offscreenCanvas, [offscreenCanvas])`), the pixel size, and
   `Comlink.proxy(sink)`.
4. **`createGame` awaits `initialized`, then `await WgpuApp.create(canvas, size)`.**
   `create` is async because `request_adapter` and `request_device` are async, so
   the GPU is fully initialized before the first frame.
5. **The worker starts its own `requestAnimationFrame(update)` loop.** Each tick
   calls `app.update()`, fires `onReady` once (with `adapter_info`), and throttles
   `onStats` to every 250 ms.
6. **The page gets the `GameApi` proxy back**, queries `context()` (which returns
   `"DedicatedWorkerGlobalScope"` — proof the renderer runs off-thread), wires up
   input listeners, and starts its own main-thread heartbeat loop.

## The renderer

`src/lib.rs` is hand-written `wgpu` with no engine and no windowing layer.
`WgpuApp` holds a `Gpu`, a depth texture view, a `Scene`, `Controls`, an
`OrbitCamera`, and `FrameStats`.

**Surface creation** (`Gpu::new_async`) is the key simplification. The surface
comes straight from the transferred canvas:

```rust
instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas))
```

Because wgpu has a first-class offscreen-canvas surface target, there is no
`winit`, no `raw-window-handle`, and none of the `unsafe impl Send + Sync`
window-handle wrapper that
[bevy-worker](https://github.com/matthewjberger/bevy-worker) needs to satisfy
Bevy's window-shaped renderer. It then requests an adapter and device and picks
the first **non-sRGB** surface format so the shader does its own sRGB conversion.

**The scene** (`Scene`) is a 24-vertex / 36-index cube built per face with
outward normals (`build_cube`), one uniform buffer, and one render pipeline from
inline WGSL. The uniform (`UniformBuffer`) carries `mvp`, `model`, `tint`, and
`hit_point`.

**Per-frame update** (`Scene::update`) builds a left-handed perspective
projection (`perspective_lh_zo` — the `_zo` is WebGPU's 0..1 depth range), a
`look_at_lh` view from the orbit camera, and a two-axis spin model matrix, then
uploads them with `queue.write_buffer`.

**Render** (`WgpuApp::render`) is a single pass: clear to dark gray, depth
attachment (`Depth32Float`, `Less` compare), draw the indexed cube, submit,
present. A lost/outdated surface triggers a reconfigure and a skipped frame.

**The WGSL shader** (`SHADER_SOURCE`) does Lambert diffuse shading with a
`0.25 + 0.75 * diffuse` floor, applies the tint in linear space, and — when
`hit_point.w > 0.5` — paints an orange marker blob around the picked point with
`smoothstep`. It converts sRGB↔linear by hand because the surface format is
non-sRGB.

## Input handling and coalescing

The offscreen canvas can't receive DOM events, so `main.ts` captures them on the
placeholder canvas. Pointer-move and wheel handlers accumulate into `pendingYaw`,
`pendingPitch`, `pendingZoom` rather than messaging immediately. A main-thread
`requestAnimationFrame` tick flushes them once per frame — at most one `orbit`
and one `zoom` call per frame regardless of event volume — and increments the
`heartbeat` counter that visibly freezes during the jam test.

A `pointerup` that moved less than 4 px is treated as a click: the position is
converted to normalized device coordinates and sent through `game.pick(x, y)`.
A `ResizeObserver` forwards DPR-scaled `game.resize(...)` on layout changes.

## Picking

Picking is a CPU ray cast inside the worker — no GPU readback. `WgpuApp::pick`
unprojects the NDC point through `inverse(view_proj)` to get near/far world
points, transforms the ray into the cube's local space via `inverse(model)`, runs
a slab ray/AABB intersection (`ray_cube_hit`) against the half-extent cube, and
returns the hit point and face name (`+X`, `-Y`, …). The hit point is stored in
`hit_point` so the shader draws the marker.

## Per-frame data flow

```
MAIN THREAD                                    WEB WORKER
───────────                                    ──────────
pointer/wheel events
    │ accumulate into pending*
    ▼
rAF tick (once per frame)
    │ game.orbit(), game.zoom()  ────────────▶ app.orbit() / app.zoom()
    │ heartbeat += 1
                                               rAF loop (once per frame)
                                                   │ app.update()
                                                   │   Scene::update → queue.write_buffer
                                                   │   render() → submit + present
                                                   │ every 250 ms:
    fps / frames  ◀───────── sink.onStats(stats) ──┘

click ── game.pick(x,y) ────────────────────▶ WgpuApp::pick (ray/AABB)
    pick text  ◀──────── (PickResult return) ──┘

jam button:
  game.stats() ──────────────────────────────▶ WgpuApp::stats()
  busy-loop 3s  (worker keeps rendering throughout)
  game.stats() ──────────────────────────────▶ WgpuApp::stats()
  report advanced frames
```

The two `requestAnimationFrame` loops are independent. The main thread's only
batches input and ticks the heartbeat; the worker's drives the renderer. Blocking
the former does nothing to the latter — which is the entire demonstration.

## Build pipeline

`just run` (`justfile`):

1. `cargo build --release --target wasm32-unknown-unknown` — compile the crate to
   wasm.
2. `wasm-bindgen --target web --out-dir web/src/wasm --out-name webgpu_worker …` —
   emit the JS glue and `.d.ts` types into `web/src/wasm/`.
3. `wasm-opt -Oz …` — shrink the wasm in place.
4. `cd web; npm run dev` — Vite serves the page (and bundles `worker.ts` as an ES
   module worker) at `http://localhost:5173`.

The wasm build is a bare `cargo build` → `wasm-bindgen --target web` →
`wasm-opt -Oz`, deliberately without `wasm-pack` or `vite-plugin-wasm`; the worker
loads the module with an explicit `init({ module_or_path })` against a `?url`
asset path. The GitHub Pages deploy (`.github/workflows/deploy.yml`) runs the same
wasm steps, then `npm run build`, and publishes `web/dist`.

Requires a browser with WebGPU and `OffscreenCanvas`-in-workers support
(Chromium 113+, Firefox 141+).

## Why it is shaped this way

- **Raw wgpu, not an engine** — going straight to wgpu via
  `SurfaceTarget::OffscreenCanvas` removes `winit`, `raw-window-handle`, and the
  unsafe window-handle wrapper that
  [bevy-worker](https://github.com/matthewjberger/bevy-worker) needs. The whole
  renderer is a few hundred lines.
- **Surface from `OffscreenCanvas` directly** — the canvas is the surface target;
  there is no window to fake.
- **Comlink instead of a message enum** — RPC method calls and proxied callbacks
  keep the TS side ergonomic; the tradeoff is that the page and worker are coupled
  at the API surface, with no shared compile-time type guarantee across the
  language boundary (the all-Rust
  [webgpu-worker-leptos](https://github.com/matthewjberger/webgpu-worker-leptos)
  closes that gap with a shared `protocol` crate).
</content>
