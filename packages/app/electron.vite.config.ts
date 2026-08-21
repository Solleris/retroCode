import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
        external: ["electron"],
        output: { format: "es", entryFileNames: "index.mjs" },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        external: ["electron"],
        // Electron only loads an ESM preload when the extension is .mjs — a
        // .js file with `import` inside fails at runtime, with no useful error.
        output: { format: "es", entryFileNames: "index.mjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
  },
});
