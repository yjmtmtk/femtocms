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
  // The Cache API is not isolated either, and wiping settings restarts content_version at 1, which would revive
  // edge-cache entries from earlier tests (same URL + same version). Start each test from a distinct version.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('content_version', ?)")
    .bind(String(Math.floor(Math.random() * 1e9) + 1))
    .run();
  // R2 is not isolated either: delete every object.
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ cursor });
    if (page.objects.length) await env.MEDIA.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});
