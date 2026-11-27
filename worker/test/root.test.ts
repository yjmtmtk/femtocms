import { SELF, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { VERSION } from "../src/version";

it("GET / returns the site introduction", async () => {
  const res = await SELF.fetch("https://cms.test/");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    name: "femtocms", site: "dev-site", version: VERSION,
    api: "https://cms.test/api", mcp: "https://cms.test/mcp", openapi: "https://cms.test/api/openapi.json",
  });
});
it("the migrated tables exist", async () => {
  const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").first();
  expect(r).not.toBeNull();
});

it("GET /embed.js serves the embed script as JavaScript", async () => {
  const res = await SELF.fetch("https://cms.test/embed.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  const body = await res.text();
  expect(body).toContain("window.femtocms");
  expect(body).toContain("data-femtocms");
});
