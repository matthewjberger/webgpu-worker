import { defineConfig } from "vite";

// On GitHub Pages the app is served from /webgpu-worker/, but a plain dev server
// serves from /. Only apply the base path for production builds.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/webgpu-worker/" : "/",
  worker: {
    format: "es",
  },
}));
