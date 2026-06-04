# webgpu-worker

A from-scratch [wgpu](https://wgpu.rs) app that runs in a web worker via WebAssembly. No `winit`, and no graphics code on the main thread: the worker owns an `OffscreenCanvas`, drives the render loop with `requestAnimationFrame`, and renders through WebGPU. The main thread only transfers the canvas and forwards events over [Comlink](https://github.com/GoogleChromeLabs/comlink).

This is the raw-wgpu counterpart to [bevy-worker](https://github.com/matthewjberger/bevy-worker): same worker architecture and build pipeline, but a hand-written renderer instead of an engine. The worker approach follows Nick Babcock's [write-up on running a Bevy app off the main thread](https://nickb.dev/blog/a-bevy-app-entirely-off-the-main-thread/), and the build pipeline follows his [post on deconstructing wasm-pack](https://nickb.dev/blog/life-after-wasm-pack-an-opinionated-deconstruction/).

## Live demo

[matthewberger.dev/webgpu-worker](https://matthewberger.dev/webgpu-worker/). Needs a browser with WebGPU and `OffscreenCanvas`-in-workers support (Chromium 113+, Firefox 141+).

## Proving the work runs off the main thread

The page renders a spinning, lit 3D cube and a control panel that demonstrates the GPU pipeline and render loop live in the worker:

- The wasm module reports its own JavaScript global scope (`DedicatedWorkerGlobalScope`), so the wgpu code itself confirms where it runs.
- A "Jam main thread for 3 s" button synchronously blocks the page. The main-thread heartbeat counter freezes, but the cube keeps spinning and the panel reports how many frames wgpu advanced while the page was stalled.
- Rotation-speed and color controls send events into the worker and update the running scene.

## How it works

- `src/lib.rs` exposes a `WgpuApp` (`create` / `update` / `resize` / control methods) through `wasm-bindgen` (`--target web`). `create` is async because `request_adapter` and `request_device` are async, so it returns a `Promise` the worker awaits.
- The surface comes straight from the transferred canvas via `wgpu::SurfaceTarget::OffscreenCanvas`, so `instance.create_surface(...)` just works. Because nothing routes through `winit` or `raw-window-handle`, there is no `unsafe impl Send + Sync` and no custom window-handle wrapper. That plumbing in [bevy-worker](https://github.com/matthewjberger/bevy-worker) exists only to satisfy Bevy's winit-shaped `Window` layer, whose `RawHandleWrapper` demands a `Send + Sync` handle the `OffscreenCanvas` doesn't provide. Going straight to wgpu removes the requirement entirely.
- The renderer is a plain wgpu setup: instance, surface, adapter, device, a depth texture, one uniform buffer (MVP, model matrix, tint), and a pipeline from inline WGSL that does Lambert shading.
- `web/src/worker.ts` initializes the module explicitly with `init({ module_or_path })` (a `?url` import, no `vite-plugin-wasm`) and drives `app.update()` from `requestAnimationFrame`.
- `web/src/main.ts` transfers the canvas with `Comlink.transfer` and forwards control and resize events. The UI is plain HTML and CSS.

## Quickstart

Tooling is pinned in [`mise.toml`](mise.toml): node, rust with the `wasm32-unknown-unknown` target, [`wasm-bindgen`](https://github.com/rustwasm/wasm-bindgen), and [`wasm-opt`](https://github.com/WebAssembly/binaryen). Install [mise](https://mise.jdx.dev) and [just](https://github.com/casey/just), then:

```bash
mise install     # fetch the pinned toolchain
just run         # build, optimize, and serve at http://localhost:5173
```

Run `just` with no arguments to list every recipe. The wasm pipeline is a bare `cargo build` -> `wasm-bindgen --target web` -> `wasm-opt -Oz`.

## Deployment

Pushing to `main` builds the wasm module and the web bundle and publishes to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

Dual-licensed under MIT or Apache-2.0, at your option.
