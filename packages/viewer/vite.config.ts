import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "node:path";

export default defineConfig({
  plugins: [react()],
  publicDir: path.resolve(__dirname, "../../viewer-data"),
  server: {
    port: 5173,
    open: true,
  },
});
