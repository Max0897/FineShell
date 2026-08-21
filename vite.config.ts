import { resolve } from "node:path";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const analyze = mode === "analyze";
  const plugins: PluginOption[] = [react()];

  if (analyze) {
    plugins.push(
      visualizer({
        filename: resolve("reports/size/frontend-bundle.html"),
        template: "treemap",
        gzipSize: true,
        brotliSize: true,
        open: false,
        title: "FineShell 前端依赖体积",
      }) as PluginOption,
    );
  }

  return {
    plugins,

    build: analyze
      ? {
          outDir: "reports/size/frontend-dist",
          emptyOutDir: true,
        }
      : undefined,

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
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
