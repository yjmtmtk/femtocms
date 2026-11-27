import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCollection } from "../src/core/collections";
import { createCtx, getSetting, setSetting } from "../src/core/context";
import { createEntry, publishEntry } from "../src/core/entries";
import { bootstrapSql } from "../src/core/key-format";
import { createKey } from "../src/core/keys";
import { uploadMedia } from "../src/core/media";
import { createPreviewUrl, verifyPreviewToken } from "../src/core/preview";
import { trashEntry } from "../src/core/trash";
import type { Collection } from "../src/core/types";
import { renderPreviewPage } from "../src/public/preview-page";
import { fixtures } from "./fixtures/images";

const admin = () => createCtx(env, "https://cms.test", "admin");
const pub = () => createCtx(env, "https://cms.test", "public");
const K = "fcms_admin_" + "a".repeat(32);
const get = (path: string) => SELF.fetch(`https://cms.test${path}`);

beforeEach(async () => {
  await createCollection(admin(), {
    name: "news",
    fields: [{ name: "title", type: "text", required: true }, { name: "body", type: "markdown" }],
  });
});

describe("preview page", () => {
  it("a draft can be viewed at the preview URL, and HTML in the title is escaped", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "<script>alert(1)</script>", body: "**太字**" } });
    const { url } = await createPreviewUrl(admin(), "news", e.id);
    expect(url).toMatch(/^https:\/\/cms\.test\/preview\/[\w-]+\.[\w-]+$/);
    const res = await SELF.fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>太字</strong>");
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain("Preview (draft)");
  });

  it("HTML, cache, crawl and CSP headers are set", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const res = await SELF.fetch((await createPreviewUrl(admin(), "news", e.id)).url);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'");
  });

  it("an expired, tampered or broken token gives 401 (a short body that is neither HTML nor JSON, no-store)", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const other = await createEntry(admin(), "news", { data: { title: "b" } });
    const { token } = await createPreviewUrl(admin(), "news", e.id, { ttlSeconds: -1 });
    const otherToken = (await createPreviewUrl(admin(), "news", other.id)).token;
    const [payload] = token.split(".");
    const forged = `${payload}.${otherToken.split(".")[1]}`;
    const swapped = `${otherToken.split(".")[0]}.${token.split(".")[1]}`;
    for (const t of [token, `${token}x`, forged, swapped, "abc", "a.b.c", "!!!.???", ".a", `${payload}.`, "%E0%A4%A"]) {
      const res = await get(`/preview/${t}`);
      expect(res.status, t).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Type")).toContain("text/plain");
    }
  });

  it("verifyPreviewToken: a valid token returns entryId, a broken one is unauthorized", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const { token, expiresAt } = await createPreviewUrl(admin(), "news", e.id);
    expect(await verifyPreviewToken(pub(), token)).toEqual({ entryId: e.id });
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(86_300_000);
    expect(ttl).toBeLessThanOrEqual(86_400_000);
    for (const t of ["", "x", "a.b.c", "%%%.%%%", `${token}x`, `x${token}`]) {
      await expect(verifyPreviewToken(pub(), t)).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("existing tokens become invalid when the secret key changes", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const { token } = await createPreviewUrl(admin(), "news", e.id);
    await setSetting(admin(), "preview_secret", "00".repeat(32));
    await expect(verifyPreviewToken(pub(), token)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("the secret key is created only once, and concurrent issuing converges on the same key", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    expect(await getSetting(admin(), "preview_secret")).toBeNull();
    const made = await Promise.all([1, 2, 3, 4, 5].map(() => createPreviewUrl(admin(), "news", e.id)));
    const secret = await getSetting(admin(), "preview_secret");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    for (const { token } of made) expect(await verifyPreviewToken(pub(), token)).toEqual({ entryId: e.id });
  });

  it("the preview of a trashed entry gives 404", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const { url, token } = await createPreviewUrl(admin(), "news", e.id);
    await trashEntry(admin(), "news", e.id);
    const res = await SELF.fetch(url);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await get(`/api/news/${e.id}?preview=${token}`)).status).toBe(404);
  });

  it("only an admin can issue one, and a missing entry gives not_found", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await expect(createPreviewUrl(pub(), "news", e.id)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(createPreviewUrl(createCtx(env, "https://cms.test", "read"), "news", e.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createPreviewUrl(admin(), "news", "e_nope00000000")).rejects.toMatchObject({ code: "not_found" });
  });

  it("can be issued for an entry given by slug, and published entries can be viewed", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "公開" }, slug: "pub" });
    await publishEntry(admin(), "news", "pub");
    const { url } = await createPreviewUrl(admin(), "news", "pub");
    expect(await (await SELF.fetch(url)).text()).toContain("公開");
    expect(await verifyPreviewToken(pub(), url.split("/preview/")[1])).toEqual({ entryId: e.id });
  });
});

describe("?preview= and POST /api/:c/:id/preview", () => {
  beforeEach(async () => {
    await env.DB.exec(await bootstrapSql(K, "test", "2026-11-26T00:00:00.000Z"));
  });

  it("?preview= returns a draft as JSON, but cannot be used for another entry", async () => {
    const a = await createEntry(admin(), "news", { data: { title: "A" }, slug: "a" });
    const b = await createEntry(admin(), "news", { data: { title: "B" }, slug: "b" });
    const { token } = await createPreviewUrl(admin(), "news", a.id);
    expect((await get(`/api/news/${a.id}`)).status).toBe(404);

    for (const idOrSlug of [a.id, "a"]) {
      const ok = await get(`/api/news/${idOrSlug}?preview=${token}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await ok.json()).toMatchObject({ id: a.id, status: "draft", data: { title: "A" } });
    }
    const other = await get(`/api/news/${b.id}?preview=${token}`);
    expect(other.status).toBe(404);
    expect(other.headers.get("Cache-Control")).toBe("no-store");
  });

  it("an invalid token gives 401, and a published entry can be read normally even with the token of another entry", async () => {
    const a = await createEntry(admin(), "news", { data: { title: "A" } });
    const b = await createEntry(admin(), "news", { data: { title: "B" }, status: "published" });
    const bad = await get(`/api/news/${a.id}?preview=garbage`);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("Cache-Control")).toBe("no-store");
    expect(await bad.json()).toMatchObject({ error: { code: "unauthorized" } });
    const { token } = await createPreviewUrl(admin(), "news", a.id);
    const res = await get(`/api/news/${b.id}?preview=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("a draft in a private collection can be read anonymously with a token", async () => {
    await createCollection(admin(), { name: "secret", public: false, fields: [{ name: "title", type: "text" }] });
    const e = await createEntry(admin(), "secret", { data: { title: "S" } });
    const { token } = await createPreviewUrl(admin(), "secret", e.id);
    expect((await get(`/api/secret/${e.id}`)).status).toBe(404);
    expect(await (await get(`/api/secret/${e.id}?preview=${token}`)).json()).toMatchObject({ id: e.id, data: { title: "S" } });
    expect((await SELF.fetch((await createPreviewUrl(admin(), "secret", e.id)).url)).status).toBe(200);
  });

  it("POST /api/:c/:id/preview returns { url, token, expiresAt }", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const post = (body?: string, key: string | null = K) =>
      SELF.fetch(`https://cms.test/api/news/${e.id}/preview`, {
        method: "POST",
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        body,
      });
    const res = await post();
    expect(res.status).toBe(200);
    const out = (await res.json()) as { url: string; token: string; expiresAt: string };
    expect(out.url).toBe(`https://cms.test/preview/${out.token}`);
    expect((await SELF.fetch(out.url)).status).toBe(200);
    expect(Date.parse(out.expiresAt) - Date.now()).toBeGreaterThan(86_300_000);

    const short = (await (await post(JSON.stringify({ ttlSeconds: 60 }))).json()) as { expiresAt: string };
    expect(Date.parse(short.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);

    for (const ttlSeconds of [0, -1, 2_592_001, 1.5, "60"]) {
      const bad = await post(JSON.stringify({ ttlSeconds }));
      expect(bad.status, String(ttlSeconds)).toBe(422);
    }
    expect((await post("not json")).status).toBe(400);
    expect((await post(undefined, null)).status).toBe(401);
    const readKey = ((await createKey(admin(), { name: "r", role: "read" })) as { key: string }).key;
    expect((await post(undefined, readKey)).status).toBe(403);
  });

  it("issuing a preview for a missing entry gives 404", async () => {
    const res = await SELF.fetch("https://cms.test/api/news/nope/preview", { method: "POST", headers: { Authorization: `Bearer ${K}` } });
    expect(res.status).toBe(404);
  });
});

describe("renderPreviewPage", () => {
  const collection: Collection = {
    id: "c_x", name: "news", label: "お知らせ<b>", description: null, kind: "list", public: true,
    createdAt: "", updatedAt: "",
    fields: [
      { name: "title", type: "text", label: "題名\"'" },
      { name: "body", type: "markdown" },
      { name: "cover", type: "image" },
      { name: "views", type: "number" },
      { name: "flag", type: "boolean" },
      { name: "meta", type: "json" },
      { name: "tags", type: "list", fields: [{ name: "t", type: "text" }] },
      { name: "empty", type: "text" },
    ],
  };
  const entry = (data: Record<string, unknown>, html: Record<string, string> = {}) => ({
    id: "e_1", slug: "s", status: "draft" as const, createdAt: "", updatedAt: "", publishedAt: null, data, html,
  });

  it("strings, labels and image attributes are always escaped, and only the markdown html is inserted raw", () => {
    const out = renderPreviewPage(
      collection,
      entry(
        {
          title: `<img src=x onerror=alert(1)>"&`,
          body: "<script>x</script>",
          cover: { id: "m_1", url: `https://cms.test/media/m_1/a"><script>.png`, alt: `"><script>alert(2)</script>` },
          views: 3, flag: false, meta: { k: "<i>" }, tags: [{ t: "<u>" }],
        },
        { body: "<p>ok</p>" },
      ),
    );
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain('<meta name="robots" content="noindex">');
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&amp;");
    expect(out).toContain("題名&quot;&#39;");
    expect(out).toContain("お知らせ&lt;b&gt;");
    expect(out).toContain("<p>ok</p>");
    expect(out).toContain('alt="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"');
    expect(out).toContain("a&quot;&gt;&lt;script&gt;.png");
    expect(out).toContain("<pre>3</pre>");
    expect(out).toContain("<pre>false</pre>");
    expect(out).toContain("&lt;i&gt;");
    expect(out).toContain("&lt;u&gt;");
    expect(out).not.toMatch(/<script|<img src=x|<i>|<u>/);
  });

  it("only one img (the image field), and empty fields are rendered without failing", () => {
    const out = renderPreviewPage(collection, entry({ cover: null }));
    expect(out).not.toContain("<img");
    expect(out).toContain("empty");
  });
});

describe("real image data", () => {
  it("the image field is rendered as <img>", async () => {
    await createCollection(admin(), { name: "shot", fields: [{ name: "cover", type: "image" }] });
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png", alt: "猫<>" });
    const e = await createEntry(admin(), "shot", { data: { cover: m.id } });
    const html = await (await SELF.fetch((await createPreviewUrl(admin(), "shot", e.id)).url)).text();
    expect(html).toContain(`<img src="https://cms.test/media/${m.id}/a.png"`);
    expect(html).toContain('alt="猫&lt;&gt;"');
  });
});
