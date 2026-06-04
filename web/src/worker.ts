import init, {
  WgpuApp,
  type CanvasSize,
  type Stats,
} from "./wasm/webgpu_worker.js";

// Explicit wasm-bindgen (target web) initialization. The ?url import hands Vite
// the digested asset path; we feed it to init via module_or_path. No
// vite-plugin-wasm and no bundler-target glue involved.
import wasmPath from "./wasm/webgpu_worker_bg.wasm?url";

import { expose, proxy } from "comlink";

const initialized = init({ module_or_path: wasmPath });

const createGame = async (canvas: OffscreenCanvas, size: CanvasSize) => {
  await initialized;

  // request_adapter / request_device are async, so the constructor is an async
  // factory that returns a Promise the worker awaits. No winit, no RawHandleWrapper:
  // wgpu takes the transferred OffscreenCanvas as a surface target directly.
  const app = await WgpuApp.create(canvas, size);

  // Nothing drives the render loop for us, so requestAnimationFrame in the worker
  // is the loop.
  function update() {
    app.update();
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
    stats: () => app.stats(),
    context: () => app.context(),
  });
};

// The local shape the worker implements. Comlink.wrap<WorkerApi> on the main
// thread applies Remote<> over this, turning each method into a Promise-returning
// proxy call, so we must NOT wrap it here.
export type GameApi = {
  resize: (size: CanvasSize) => void;
  setSpeed: (speed: number) => void;
  setColor: (red: number, green: number, blue: number) => void;
  orbit: (deltaYaw: number, deltaPitch: number) => void;
  zoom: (amount: number) => void;
  stats: () => Stats;
  context: () => string;
};

export type WorkerApi = {
  createGame: (canvas: OffscreenCanvas, size: CanvasSize) => Promise<GameApi>;
};

expose({ createGame } satisfies WorkerApi);
