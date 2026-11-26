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
  // Storage is not isolated per test, so start every test from empty tables (entries before collections: FK).
  await env.DB.batch(
    ["entries", "media", "api_keys", "settings", "collections"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  // R2 is not isolated either: delete every object.
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ cursor });
    if (page.objects.length) await env.MEDIA.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});
