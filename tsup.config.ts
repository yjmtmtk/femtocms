import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

// The published CLI: dist/cli/index.js, one ESM file (the shebang in cli/src/index.ts is kept).
// Every dependency stays external and is installed with the package, wrangler included. The few
// files shared with the worker (worker/src/core/key-format.ts, ids.ts) are bundled in because
// "worker/src" is not shipped as source.
export default defineConfig({
  entry: { "cli/index": "cli/src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  external: Object.keys(pkg.dependencies),
  clean: false, // dist/worker is built by scripts/build-worker.mjs and must survive
  dts: false,
  sourcemap: false,
  splitting: false,
});
