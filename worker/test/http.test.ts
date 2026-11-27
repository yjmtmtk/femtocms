import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as collectionsModule from "../src/core/collections";
import { bootstrapSql, generateKey } from "../src/core/key-format";
import { errorResponse } from "../src/http/errors";
import { fixtures } from "./fixtures/images";

const K = "fcms_admin_" + "a".repeat(32);
const NOW = "2026-11-26T00:00:00.000Z";

interface Opts { body?: unknown; key?: string; headers?: Record<string, string> }
const api = (method: string, path: string, { body, key, headers }: Opts = {}) =>
  SELF.fetch(`https://cms.test${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

const news = {
  name: "news",
  fields: [{ name: "title", type: "text", required: true }, { name: "body", type: "markdown" }],
};
const site = { name: "site", kind: "single", fields: [{ name: "title", type: "text" }] };

beforeEach(async () => {
  await env.DB.exec(await bootstrapSql(K, "test", NOW));
});
afterEach(() => vi.restoreAllMocks());

describe("collection and entry flow", () => {
  it("full flow: create collection → create entry → publish → readable without a key", async () => {
    expect((await api("POST", "/api/collections", { key: K, body: news })).status).toBe(201);
    const created = await api("POST", "/api/news", { key: K, body: { data: { title: "冬" }, slug: "winter" } });
    expect(created.status).toBe(201);
    const e = await json(created);
    expect((await api("GET", "/api/news/winter")).status).toBe(404);
    expect((await api("POST", `/api/news/${e.id}/publish`, { key: K })).status).toBe(200);
    const list = await json(await api("GET", "/api/news"));
    expect(list).toMatchObject({ total: 1, limit: 10, offset: 0, items: [{ slug: "winter", data: { title: "冬" } }] });
    expect(await json(await api("GET", "/api/news/winter"))).toMatchObject({ id: e.id, status: "published" });
  });

  it("get, update and delete of a collection (204 with no body) and the list", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    expect(await json(await api("GET", "/api/collections"))).toMatchObject({ items: [{ name: "news" }] });
    expect(await json(await api("GET", "/api/collections/news"))).toMatchObject({ name: "news", kind: "list" });
    const patched = await api("PATCH", "/api/collections/news", { key: K, body: { label: "お知らせ" } });
    expect(await json(patched)).toMatchObject({ name: "news", label: "お知らせ" });
    const del = await api("DELETE", "/api/collections/news", { key: K });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await api("GET", "/api/collections/news")).status).toBe(404);
  });

  it("PATCH / unpublish / DELETE (to the trash) / passing fields and expand", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    const e = await json(await api("POST", "/api/news", { key: K, body: { data: { title: "a", body: "**b**" }, status: "published" } }));
    expect(e).toMatchObject({ status: "published", html: { body: expect.stringContaining("<strong>b</strong>") } });
    const patched = await json(await api("PATCH", `/api/news/${e.id}`, { key: K, body: { data: { title: "z" } } }));
    expect(patched.data).toMatchObject({ title: "z", body: "**b**" });
    const sel = await json(await api("GET", "/api/news?fields=title"));
    expect(sel.items[0].data).toEqual({ title: "z" });
    expect((await json(await api("POST", `/api/news/${e.id}/unpublish`, { key: K }))).status).toBe("draft");
    expect((await api("DELETE", `/api/news/${e.id}`, { key: K })).status).toBe(204);
    expect((await api("GET", `/api/news/${e.id}`, { key: K })).status).toBe(404);
    expect((await json(await api("GET", "/api/trash", { key: K }))).items).toMatchObject([{ type: "entry", id: e.id }]);
  });

  it("single: GET returns the one entry (404 if none), PUT creates or updates it, PUT to a list collection gives 400", async () => {
    await api("POST", "/api/collections", { key: K, body: site });
    await api("POST", "/api/collections", { key: K, body: news });
    expect((await api("GET", "/api/site", { key: K })).status).toBe(404);
    const put = await api("PUT", "/api/site", { key: K, body: { data: { title: "A" }, status: "published" } });
    expect(put.status).toBe(200);
    expect(await json(await api("GET", "/api/site"))).toMatchObject({ data: { title: "A" }, status: "published" });
    expect((await json(await api("PUT", "/api/site", { key: K, body: { data: { title: "B" } } }))).data.title).toBe("B");
    expect((await json(await api("PUT", "/api/news", { key: K, body: { data: {} } }))).error.code).toBe("bad_request");
  });

  it("a validation error gives 422 and includes issues", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    const res = await api("POST", "/api/news", { key: K, body: { data: { title: 1 } } });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatchObject({ code: "validation_failed", issues: [{ path: "data.title" }] });
  });

  it("a body status other than draft/published gives 422 (for both POST and PUT)", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    await api("POST", "/api/collections", { key: K, body: site });
    for (const [method, path] of [["POST", "/api/news"], ["PUT", "/api/site"]] as const) {
      const res = await api(method, path, { key: K, body: { data: {}, status: "archived" } });
      expect(res.status).toBe(422);
      expect((await json(res)).error).toMatchObject({ code: "validation_failed", issues: [{ path: "status" }] });
    }
  });

  it("invalid JSON or a body that is not an object gives 400 with a hint", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    for (const body of ["{oops", "[1]", "null", ""]) {
      const res = await api("POST", "/api/news", { key: K, body });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toMatchObject({ code: "bad_request", hint: expect.any(String) });
    }
  });

  it("collection POST: a duplicate gives 409", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    expect((await api("POST", "/api/collections", { key: K, body: news })).status).toBe(409);
  });
});

describe("authorization", () => {
  it("a write without a key gives 401, and a write with a read key gives 403", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    const created = await json(await api("POST", "/api/keys", { key: K, body: { name: "r", role: "read" } }));
    const res401 = await api("POST", "/api/news", { body: { data: { title: "x" } } });
    expect(res401.status).toBe(401);
    expect((await json(res401)).error.code).toBe("unauthorized");
    const res403 = await api("POST", "/api/news", { key: created.key, body: { data: { title: "x" } } });
    expect(res403.status).toBe(403);
    expect((await json(res403)).error.code).toBe("forbidden");
  });

  it("an invalid or revoked key gives 401", async () => {
    expect((await api("GET", "/api/collections", { key: generateKey("admin") })).status).toBe(401);
    expect((await api("GET", "/api/collections", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("a collection with public:false needs a read key", async () => {
    await api("POST", "/api/collections", { key: K, body: { ...news, public: false } });
    await api("POST", "/api/news", { key: K, body: { data: { title: "x" }, slug: "x", status: "published" } });
    const { key } = await json(await api("POST", "/api/keys", { key: K, body: { name: "r", role: "read" } }));
    expect((await api("GET", "/api/news")).status).toBe(404);
    expect((await api("GET", "/api/news/x")).status).toBe(404);
    const res = await api("GET", "/api/news", { key });
    expect(res.status).toBe(200);
    expect((await json(res)).total).toBe(1);
  });
});

describe("media", () => {
  it("an image can be uploaded with multipart", async () => {
    const form = new FormData();
    form.set("file", new File([fixtures.png], "dot.png", { type: "image/png" }));
    form.set("alt", "点");
    const res = await SELF.fetch("https://cms.test/api/media", { method: "POST", headers: { Authorization: `Bearer ${K}` }, body: form });
    expect(res.status).toBe(201);
    const m = await json(res);
    expect(m).toMatchObject({ filename: "dot.png", alt: "点", mimeType: "image/png", width: 1, height: 1 });
    expect(m.url).toMatch(/^https:\/\/cms\.test\/media\/m_[0-9a-z]{12}\/dot\.png$/);
    const served = await SELF.fetch(m.url);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(fixtures.png);
  });

  it("multipart without a file gives 400", async () => {
    const form = new FormData();
    form.set("alt", "x");
    const res = await SELF.fetch("https://cms.test/api/media", { method: "POST", headers: { Authorization: `Bearer ${K}` }, body: form });
    expect(res.status).toBe(400);
  });

  it("can be uploaded as JSON base64; neither url nor base64 gives 400", async () => {
    const b64 = btoa(String.fromCharCode(...fixtures.png));
    const res = await api("POST", "/api/media", { key: K, body: { base64: b64, filename: "p.png", alt: "x" } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ filename: "p.png", alt: "x", width: 1 });
    expect((await api("POST", "/api/media", { key: K, body: { alt: "x" } })).status).toBe(400);
    expect((await api("POST", "/api/media", { key: K, body: { base64: b64 } })).status).toBe(422);
  });

  it("can be imported from a JSON url (the external fetch is mocked)", async () => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      String(input).startsWith("https://img.test/")
        ? new Response(fixtures.png, { headers: { "Content-Type": "image/png" } })
        : real(input, init));
    const res = await api("POST", "/api/media", { key: K, body: { url: "https://img.test/a/pic.png" } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ filename: "pic.png", mimeType: "image/png" });
  });

  it("PUT /api/media/:id overwrites while keeping the id, and validates the id format", async () => {
    const id = "m_0123456789ab";
    const res = await SELF.fetch(`https://cms.test/api/media/${id}?filename=a.png&alt=hi`, {
      method: "PUT", headers: { Authorization: `Bearer ${K}`, "Content-Type": "image/png" }, body: fixtures.png,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id, filename: "a.png", alt: "hi", width: 1 });
    const bad = await SELF.fetch("https://cms.test/api/media/m_XYZ?filename=a.png", {
      method: "PUT", headers: { Authorization: `Bearer ${K}` }, body: fixtures.png,
    });
    expect(bad.status).toBe(400);
    const noName = await SELF.fetch(`https://cms.test/api/media/${id}`, {
      method: "PUT", headers: { Authorization: `Bearer ${K}` }, body: fixtures.png,
    });
    expect(noName.status).toBe(400);
  });

  it("list, PATCH(alt) and DELETE; writes need an admin key", async () => {
    const id = "m_aaaaaaaaaaaa";
    await SELF.fetch(`https://cms.test/api/media/${id}?filename=a.png`, {
      method: "PUT", headers: { Authorization: `Bearer ${K}` }, body: fixtures.png,
    });
    const list = await json(await api("GET", "/api/media", { key: K }));
    expect(list).toMatchObject({ total: 1, limit: 10, offset: 0, items: [{ id }] });
    expect((await json(await api("PATCH", `/api/media/${id}`, { key: K, body: { alt: "新" } }))).alt).toBe("新");
    expect((await api("GET", "/api/media")).status).toBe(401);
    expect((await api("DELETE", `/api/media/${id}`, { key: K })).status).toBe(204);
    expect((await json(await api("GET", "/api/media", { key: K }))).total).toBe(0);
  });
});

describe("trash and keys", () => {
  it("restore / permanent delete (confirm is a query parameter) / empty the trash", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    const a = await json(await api("POST", "/api/news", { key: K, body: { data: { title: "a" } } }));
    const b = await json(await api("POST", "/api/news", { key: K, body: { data: { title: "b" } } }));
    await api("DELETE", `/api/news/${a.id}`, { key: K });
    await api("DELETE", `/api/news/${b.id}`, { key: K });

    expect(await json(await api("POST", `/api/trash/${a.id}/restore`, { key: K }))).toMatchObject({ type: "entry", id: a.id });
    expect((await api("GET", `/api/news/${a.id}`, { key: K })).status).toBe(200);

    const noConfirm = await api("DELETE", `/api/trash/${b.id}`, { key: K });
    expect(noConfirm.status).toBe(400);
    expect((await json(noConfirm)).error.code).toBe("confirmation_required");
    expect((await api("DELETE", `/api/trash/${b.id}?confirm=dev-site`, { key: K })).status).toBe(204);

    await api("DELETE", `/api/news/${a.id}`, { key: K });
    expect((await api("DELETE", "/api/trash", { key: K })).status).toBe(400);
    expect(await json(await api("DELETE", "/api/trash?confirm=dev-site", { key: K }))).toEqual({ deleted: 1 });
  });

  it("key creation (201 returns the plain key), list and revoke", async () => {
    const created = await api("POST", "/api/keys", { key: K, body: { name: "lp", role: "read" } });
    expect(created.status).toBe(201);
    const { key, info } = await json(created);
    expect(key).toMatch(/^fcms_read_/);
    expect(info).toMatchObject({ name: "lp", role: "read" });
    const list = await json(await api("GET", "/api/keys", { key: K }));
    expect(list.items).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(key);
    expect((await json(await api("DELETE", `/api/keys/${info.id}`, { key: K }))).revokedAt).toEqual(expect.any(String));
    expect((await api("GET", "/api/collections", { key })).status).toBe(401);
  });
});

describe("CORS", () => {
  const preflight = (path: string, origin = "https://lp.test") =>
    SELF.fetch(`https://cms.test${path}`, {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });

  it("OPTIONS gets CORS headers", async () => {
    const res = await preflight("/api/news");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Authorization,Content-Type");
  });
  it("also set on normal responses, error responses and /media", async () => {
    expect((await api("GET", "/api/collections", { headers: { Origin: "https://lp.test" } })).headers.get("access-control-allow-origin")).toBe("*");
    const err = await api("GET", "/api/nothing/here/at/all", { headers: { Origin: "https://lp.test" } });
    expect(err.status).toBe(404);
    expect(err.headers.get("access-control-allow-origin")).toBe("*");
    const media = await SELF.fetch("https://cms.test/media/m_000000000000", { headers: { Origin: "https://lp.test" } });
    expect(media.status).toBe(404);
    expect(media.headers.get("access-control-allow-origin")).toBe("*");
    expect((await preflight("/media/m_000000000000")).headers.get("access-control-allow-origin")).toBe("*");
  });
  it("with CORS_ORIGINS set, only matching origins are allowed", async () => {
    const { app } = await import("../src/index");
    const e = { ...env, CORS_ORIGINS: "https://a.test, https://b.test" };
    const req = (origin: string) =>
      app.request("/api/news", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } }, e);
    expect((await req("https://b.test")).headers.get("access-control-allow-origin")).toBe("https://b.test");
    expect((await req("https://evil.test")).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("error responses", () => {
  it("an unknown route gives a not_found JSON", async () => {
    const res = await api("GET", "/api/a/b/c/d", { key: K });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
    const other = await api("PATCH", "/api/collections", { key: K, body: {} });
    expect(other.status).toBe(404);
    expect((await json(other)).error.code).toBe("not_found");
  });

  it("errorResponse: a FemtoError keeps its shape, anything else gives 500 without leaking details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorResponse(new Error("secret db password"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "Internal error" } });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("an unexpected exception gives 500 without leaking details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(collectionsModule, "listCollections").mockRejectedValue(new Error("secret db password"));
    const res = await api("GET", "/api/collections", { key: K });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Internal error" } });
    expect(text).not.toContain("secret");
    expect(spy).toHaveBeenCalled();
  });
});

describe("export / import / reset", () => {
  it("export is admin only; an import can restore an empty site, and reset needs confirm", async () => {
    await api("POST", "/api/collections", { key: K, body: news });
    await api("POST", "/api/news", { key: K, body: { data: { title: "冬" }, slug: "winter", status: "published" } });
    expect((await api("GET", "/api/export")).status).toBe(401);
    const exp = await api("GET", "/api/export", { key: K });
    expect(exp.status).toBe(200);
    const dump = await json(exp);
    expect(dump).toMatchObject({ format: "femtocms-export", version: 1, collections: [{ name: "news" }], entries: [{ slug: "winter" }] });

    expect((await api("POST", "/api/reset", { key: K })).status).toBe(400);
    expect(await json(await api("POST", "/api/reset", { key: K, body: { confirm: "dev-site" } }))).toEqual({ trashed: 1 });
    expect((await api("GET", "/api/news/winter")).status).toBe(404);
    expect((await api("DELETE", "/api/trash?confirm=dev-site", { key: K })).status).toBe(200);

    expect((await api("POST", "/api/import", { key: K, body: { data: dump } })).status).toBe(422);
    expect((await api("POST", "/api/import", { key: K, body: { data: dump, mode: "replace" } })).status).toBe(400);
    expect(await json(await api("POST", "/api/import", { key: K, body: { data: dump, mode: "merge" } })))
      .toEqual({ collections: 1, entries: 1, media: 0 });
    expect(await json(await api("GET", "/api/news/winter"))).toMatchObject({ status: "published", data: { title: "冬" } });
  });
  it("an import validation error gives 422 with a path in issues", async () => {
    const res = await api("POST", "/api/import", { key: K, body: { mode: "merge", data: { format: "femtocms-export", version: 1, collections: [], entries: [{ id: "x" }], media: [] } } });
    expect(res.status).toBe(422);
    expect((await json(res)).error.issues.map((i: { path: string }) => i.path)).toContain("entries[0].id");
  });
});

describe("filenames containing unpaired surrogates", () => {
  it("a base64 upload gives 201, listing and serving do not give 500, and the URL is encoded correctly", async () => {
    const png = btoa(String.fromCharCode(...fixtures.png));
    const res = await api("POST", "/api/media", { key: K, body: { base64: png, filename: "\ud800.png" } });
    expect(res.status).toBe(201);
    const m = await json(res);
    expect(m.filename).toBe("\ufffd.png");
    expect(m.url).toBe(`https://cms.test/media/${m.id}/%EF%BF%BD.png`);
    const list = await api("GET", "/api/media", { key: K });
    expect(list.status).toBe(200);
    expect((await json(list)).items[0].id).toBe(m.id);
    const file = await SELF.fetch(m.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''%EF%BF%BD.png");
  });

  it("rows that are already stored (including characters replaced by D1) also do not give 500 in the list, serving and entry images", async () => {
    await env.DB.prepare(
      "INSERT INTO media (id, filename, mime_type, size, created_at) VALUES ('m_000000000bad', ?, 'image/png', 1, 'now')",
    ).bind("a\udc00b.png").run();
    await env.MEDIA.put("media/m_000000000bad", fixtures.png);
    const url = /^https:\/\/cms\.test\/media\/m_000000000bad\/a(%EF%BF%BD)+b\.png$/;
    const list = await api("GET", "/api/media", { key: K });
    expect(list.status).toBe(200);
    expect((await json(list)).items[0].url).toMatch(url);
    const file = await SELF.fetch("https://cms.test/media/m_000000000bad/x");
    expect(file.status).toBe(200);
    await api("POST", "/api/collections", { key: K, body: { name: "pages", fields: [{ name: "hero", type: "image" }] } });
    const e = await api("POST", "/api/pages", { key: K, body: { data: { hero: "m_000000000bad" } } });
    expect(e.status).toBe(201);
    expect((await json(e)).data.hero.url).toMatch(url);
  });
});
