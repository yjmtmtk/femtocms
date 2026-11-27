import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapSql } from "../src/core/key-format";

const K = "fcms_admin_" + "a".repeat(32);
const NOW = "2026-11-26T00:00:00.000Z";
const CUSTOM = "https://cms.example.com";
const WORKERS_DEV = "https://femtocms.example.workers.dev";

const call = (base: string, method: string, path: string, opts: { body?: unknown; key?: string; headers?: Record<string, string> } = {}) =>
  SELF.fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const admin = (method: string, path: string, body?: unknown) => call(CUSTOM, method, path, { key: K, body });

const news = { name: "news", fields: [{ name: "title", type: "text", required: true }] };

async function publish(title: string, slug?: string) {
  const res = await admin("POST", "/api/news", { data: { title }, slug, status: "published" });
  expect(res.status).toBe(201);
  return json(res);
}

beforeEach(async () => {
  await env.DB.exec(await bootstrapSql(K, "test", NOW));
  expect((await admin("POST", "/api/collections", news)).status).toBe(201);
});
afterEach(() => vi.restoreAllMocks());

describe("cache headers on public GET", () => {
  it("max-age=60 and a weak ETag; the same ETag gives 304 (no body, headers kept)", async () => {
    await publish("a", "a");
    for (const path of ["/api/news", "/api/news/a", "/api/collections/news"]) {
      const r1 = await call(WORKERS_DEV, "GET", path);
      expect(r1.status).toBe(200);
      expect(r1.headers.get("cache-control")).toBe("public, max-age=60");
      const etag = r1.headers.get("etag")!;
      expect(etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
      await r1.text();
      const r2 = await call(WORKERS_DEV, "GET", path, { headers: { "If-None-Match": etag } });
      expect(r2.status).toBe(304);
      expect(r2.headers.get("etag")).toBe(etag);
      expect(r2.headers.get("cache-control")).toBe("public, max-age=60");
      expect(await r2.text()).toBe("");
    }
  });

  it("If-None-Match: multiple tags, *, and a mismatch", async () => {
    await publish("a");
    const etag = (await call(WORKERS_DEV, "GET", "/api/news")).headers.get("etag")!;
    const inm = (v: string) => call(WORKERS_DEV, "GET", "/api/news", { headers: { "If-None-Match": v } });
    expect((await inm(`W/"nope", ${etag}`)).status).toBe(304);
    expect((await inm("*")).status).toBe(304);
    const miss = await inm('W/"nope"');
    expect(miss.status).toBe(200);
    expect(miss.headers.get("etag")).toBe(etag);
  });

  it("the ETag changes when the content changes", async () => {
    await publish("a");
    const etag1 = (await call(WORKERS_DEV, "GET", "/api/news")).headers.get("etag");
    await publish("b");
    const etag2 = (await call(WORKERS_DEV, "GET", "/api/news")).headers.get("etag");
    expect(etag2).not.toBe(etag1);
  });

  it("requests with a key get private, no-store (no ETag)", async () => {
    await publish("a", "a");
    for (const path of ["/api/news", "/api/news/a", "/api/collections/news"]) {
      for (const base of [WORKERS_DEV, CUSTOM]) {
        const res = await call(base, "GET", path, { key: K });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("etag")).toBeNull();
      }
    }
  });

  it("?preview= gets no-store and is not cached", async () => {
    const e = await json(await admin("POST", "/api/news", { data: { title: "draft" } }));
    const { url } = await json(await admin("POST", `/api/news/${e.id}/preview`, {}));
    const token = new URL(url).pathname.split("/").pop()!;
    const spy = vi.spyOn(caches.default, "match");
    const res = await call(CUSTOM, "GET", `/api/news/${e.id}?preview=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(spy).not.toHaveBeenCalled();
    // ...also when a plain list carries ?preview=
    const list = await call(CUSTOM, "GET", "/api/news?preview=x");
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(spy).not.toHaveBeenCalled();
  });

  it("error responses are not cached (own headers kept)", async () => {
    const res = await call(CUSTOM, "GET", "/api/news/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).not.toBe("public, max-age=60");
    expect(res.headers.get("etag")).toBeNull();
    expect((await json(res)).error.code).toBe("not_found");
  });

  it("CORS headers are present on normal, 304 and cache-hit responses", async () => {
    await publish("a");
    const origin = { Origin: "https://site.example" };
    const r1 = await call(CUSTOM, "GET", "/api/news", { headers: origin });
    expect(r1.headers.get("access-control-allow-origin")).toBe("*");
    const r2 = await call(CUSTOM, "GET", "/api/news", { headers: origin }); // cache hit (put may still be in flight; both fine)
    expect(r2.headers.get("access-control-allow-origin")).toBe("*");
    const r3 = await call(CUSTOM, "GET", "/api/news", { headers: { ...origin, "If-None-Match": r1.headers.get("etag")! } });
    expect(r3.status).toBe(304);
    expect(r3.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("edge cache on a custom domain", () => {
  it("new content is returned after a write (the version number is part of the key)", async () => {
    await publish("first");
    const before = await json(await call(CUSTOM, "GET", "/api/news"));
    expect(before.total).toBe(1);
    await publish("second");
    const after = await json(await call(CUSTOM, "GET", "/api/news"));
    expect(after.total).toBe(2);
  });

  it("the second request is served from the cache (no compute while the version is the same); a new version uses a new key", async () => {
    await publish("first", "first");
    const put = vi.spyOn(caches.default, "put");
    const r1 = await call(CUSTOM, "GET", "/api/news/first");
    const etag = r1.headers.get("etag");
    await r1.text();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const key = put.mock.calls[0][0] as Request;
    const keyUrl = new URL(key.url);
    expect(keyUrl.hash).toBe("");
    expect(keyUrl.searchParams.get("fcms-v")).toMatch(/^\d+$/);
    expect(key.method).toBe("GET");

    // Change the stored row behind the cache's back (no version bump): the cached copy is still served.
    await env.DB.prepare("UPDATE entries SET data = ? WHERE slug = 'first'").bind(JSON.stringify({ title: "tampered" })).run();
    const r2 = await json(await call(CUSTOM, "GET", "/api/news/first"));
    expect(r2.data.title).toBe("first");
    expect(put).toHaveBeenCalledTimes(1);

    // A real write bumps content_version: the new key misses and the fresh content shows.
    await admin("PATCH", "/api/news/first", { data: { title: "edited" } });
    const r3 = await call(CUSTOM, "GET", "/api/news/first");
    expect((await json(r3)).data.title).toBe("edited");
    expect(r3.headers.get("etag")).not.toBe(etag);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(new URL((put.mock.calls[1][0] as Request).url).searchParams.get("fcms-v")).not.toBe(keyUrl.searchParams.get("fcms-v"));
  });

  it("requests with a key do not use the Cache API", async () => {
    await publish("a");
    const match = vi.spyOn(caches.default, "match");
    const put = vi.spyOn(caches.default, "put");
    await (await call(CUSTOM, "GET", "/api/news", { key: K })).text();
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("non-200 responses are not put into the cache", async () => {
    const put = vi.spyOn(caches.default, "put");
    expect((await call(CUSTOM, "GET", "/api/news/missing")).status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("caches.default is not used on workers.dev", async () => {
    await publish("a");
    const match = vi.spyOn(caches.default, "match");
    const put = vi.spyOn(caches.default, "put");
    const res = await call(WORKERS_DEV, "GET", "/api/news");
    expect(res.status).toBe(200);
    await res.text();
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
