import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.JARVIS_API ?? "http://127.0.0.1:7341";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Opt-in per-process host allowlist for the cloud preview environment.
    // Nothing is allowed by default and no hostname is committed.
    allowedHosts: process.env.JARVIS_PREVIEW_HOST ? [process.env.JARVIS_PREVIEW_HOST] : undefined,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/ws":  { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2020",
  },
});
