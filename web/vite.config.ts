import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      "@contract": here("../contract"),
      // One copy of the runtime for the app and the compiled contract.
      "@midnight-ntwrk/compact-runtime": here("node_modules/@midnight-ntwrk/compact-runtime"),
    },
  },
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["@midnight-ntwrk/compact-runtime", "@midnightntwrk/onchain-runtime-v4"] },
});
