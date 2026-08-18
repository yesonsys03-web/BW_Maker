import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// 도움말 스크린샷 모드(HELP_SHOTS=1): 엔진·Tauri 접점을 전부 데모 스텁으로
// 바꿔, 실제 UI를 일반 브라우저에서 예시 데이터로 띄운다. 출고 빌드에는 아무
// 영향이 없다 — 이 별칭이 없으면 src/demo를 import하는 곳이 없다.
// @ts-expect-error process is a nodejs global
const helpShots = !!process.env.HELP_SHOTS;
const demoAlias = helpShots
  ? [
      { find: /(\.\.?\/)+lib\/engine$/, replacement: "/src/demo/engineDemo.ts" },
      { find: /(\.\.?\/)+lib\/projectFs$/, replacement: "/src/demo/projectFsDemo.ts" },
      { find: "@tauri-apps/plugin-dialog", replacement: "/src/demo/stubs/dialog.ts" },
      { find: "@tauri-apps/api/core", replacement: "/src/demo/stubs/core.ts" },
      { find: "@tauri-apps/api/event", replacement: "/src/demo/stubs/event.ts" },
      { find: "@tauri-apps/api/webview", replacement: "/src/demo/stubs/webview.ts" },
      { find: "@tauri-apps/api/path", replacement: "/src/demo/stubs/path.ts" },
      { find: "@tauri-apps/plugin-fs", replacement: "/src/demo/stubs/fs.ts" },
    ]
  : [];

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: { alias: demoAlias },

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
}));
