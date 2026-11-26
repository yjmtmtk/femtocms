import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const dir = import.meta.dirname;

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(dir, "migrations"));
  return {
    plugins: [
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
