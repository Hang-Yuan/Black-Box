import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/// <reference types="vitest/config" />

const host = process.env.TAURI_DEV_HOST;
const edition = process.env.EDITION || 'stable';

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_EDITION__: JSON.stringify(edition),
    __APP_NAME__: JSON.stringify(edition === 'alpha' ? 'Black Box Preview' : 'Black Box'),
  },

  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['src/__tests__/setup.ts'],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // The isolated runtime contains symlinked Rust registry caches. Watching
      // those caches makes every Cargo compile look like an app source edit and
      // triggers reload storms while `tauri dev` is starting.
      ignored: ["**/src-tauri/**", "**/.dev-runtime/**"],
    },
  },
}));
