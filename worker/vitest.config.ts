import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const dir = import.meta.dirname;

// @modelcontextprotocol/sdk ships sourcemaps that point at sources missing from the package; Vite warns once per file.
// Vitest replaces `customLogger`, so the filter is installed on the resolved logger instead.
const MISSING_SOURCES = /^Sourcemap for ".*" points to missing source files$/;
const quietSdkSourcemaps: Plugin = {
  name: "quiet-sdk-sourcemaps",
  configResolved(config) {
    for (const method of ["warn", "warnOnce"] as const) {
      const original = config.logger[method].bind(config.logger);
      config.logger[method] = (msg, opts) => {
        if (!MISSING_SOURCES.test(msg)) original(msg, opts);
      };
    }
  },
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(dir, "migrations"));
  return {
    plugins: [
      quietSdkSourcemaps,
      cloudflareTest({
        wrangler: { configPath: path.join(dir, "wrangler.jsonc") },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      name: "worker",
      root: dir,
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
