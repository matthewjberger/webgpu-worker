import init, {
  WgpuApp,
  type AdapterInfo,
  type CanvasSize,
  type PickResult,
  type Stats,
} from "./wasm/webgpu_worker.js";

// Explicit wasm-bindgen (target web) initialization. The ?url import hands Vite
// the digested asset path; we feed it to init via module_or_path. No
// vite-plugin-wasm and no bundler-target glue involved.
import wasmPath from "./wasm/webgpu_worker_bg.wasm?url";

import { expose, proxy } from "comlink";

const initialized = init({ module_or_path: wasmPath });

const createGame = async (
  canvas: OffscreenCanvas,
  size: CanvasSize,
  events: EventSink,
) => {
  await initialized;

  // request_adapter / request_device are async, so the constructor is an async
  // factory that returns a Promise the worker awaits. No winit, no RawHandleWrapper:
  // wgpu takes the transferred OffscreenCanvas as a surface target directly.
  const app = await WgpuApp.create(canvas, size);

  // The worker pushes events up to the main thread over the Comlink callback the
  // page handed in. The adapter is known the moment create() returns, so report it
  // once now; onStats then streams the frame counters, throttled to stay well under
  // one message per frame.
  events.onReady(app.adapter_info());

  let lastStatsPush = 0;

  function update() {
    app.update();

    const now = performance.now();
    if (now - lastStatsPush > 250) {
      lastStatsPush = now;
      events.onStats(app.stats());
    }

    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);

  // Expose worker-side handlers the main thread can call to forward events.
  return proxy({
    resize: (next: CanvasSize) => app.resize(next),
    setSpeed: (speed: number) => app.set_speed(speed),
    setColor: (red: number, green: number, blue: number) =>
      app.set_color(red, green, blue),
    orbit: (deltaYaw: number, deltaPitch: number) =>
      app.orbit(deltaYaw, deltaPitch),
    zoom: (amount: number) => app.zoom(amount),
    pick: (x: number, y: number) => app.pick(x, y),
    stats: () => app.stats(),
    context: () => app.context(),
  });
};

// The local shape the worker implements. Comlink.wrap<WorkerApi> on the main
// thread applies Remote<> over this, turning each method into a Promise-returning
// proxy call, so we must NOT wrap it here.
// The main thread implements these and passes them in (wrapped with Comlink.proxy);
// the worker calls them to push events up. This is the worker -> main direction,
// the counterpart to the main -> worker calls on GameApi.
export type EventSink = {
  onReady: (info: AdapterInfo) => void;
  onStats: (stats: Stats) => void;
};

export type GameApi = {
  resize: (size: CanvasSize) => void;
  setSpeed: (speed: number) => void;
  setColor: (red: number, green: number, blue: number) => void;
  orbit: (deltaYaw: number, deltaPitch: number) => void;
  zoom: (amount: number) => void;
  pick: (x: number, y: number) => PickResult | undefined;
  stats: () => Stats;
  context: () => string;
};

export type WorkerApi = {
  createGame: (
    canvas: OffscreenCanvas,
    size: CanvasSize,
    events: EventSink,
  ) => Promise<GameApi>;
};

expose({ createGame } satisfies WorkerApi);
