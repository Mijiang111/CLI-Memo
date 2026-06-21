import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveAuthBoundary } from "./server/auth-boundary.js";

const apiPort = Number(process.env.PORT || process.env.VITE_API_PORT || 4147);
const uiPort = Number(process.env.VITE_PORT || 5174);
const authBoundary = resolveAuthBoundary({ env: process.env });
const uiHost = authBoundary.effective.bindHost;

export default defineConfig({
  plugins: [react()],
  server: {
    port: uiPort,
    host: uiHost,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/terminal": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true
      },
      "/events": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true
      }
    }
  },
  preview: {
    port: uiPort,
    host: uiHost
  }
});
