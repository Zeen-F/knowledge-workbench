import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5186,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4386" },
  },
  build: { sourcemap: true },
});
