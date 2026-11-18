import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const workspace = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: path.join(workspace, "dist/server/web"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssMinify: false,
  },
  css: { postcss: workspace },
});
