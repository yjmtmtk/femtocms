import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/env";

// Make `env` from "cloudflare:test" carry our bindings plus the migrations injected by vitest config.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
