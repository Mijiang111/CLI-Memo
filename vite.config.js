import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:4147",
      "/terminal": {
        target: "ws://127.0.0.1:4147",
        ws: true
      },
      "/events": {
        target: "ws://127.0.0.1:4147",
        ws: true
      }
    }
  },
  preview: {
    port: 5174,
    host: "127.0.0.1"
  }
});
