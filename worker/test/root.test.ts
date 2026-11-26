import { SELF, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { VERSION } from "../src/version";

it("GET / はサイトの自己紹介を返す", async () => {
  const res = await SELF.fetch("https://cms.test/");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    name: "femtocms", site: "dev-site", version: VERSION,
    api: "https://cms.test/api", mcp: "https://cms.test/mcp", openapi: "https://cms.test/api/openapi.json",
  });
});
it("マイグレーション済みのテーブルがある", async () => {
  const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").first();
  expect(r).not.toBeNull();
});
