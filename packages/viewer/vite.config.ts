import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "node:path";
import { analyzerApi } from "./vite-plugin-analyzer.js";

const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react(), analyzerApi()],
  publicDir: path.resolve(repoRoot, "viewer-data"),
  server: {
    port: 5173,
    open: true,
    // Allow the SSR-loaded analyzer source (outside the viewer package) to be read.
    fs: { allow: [repoRoot] },
  },
});
