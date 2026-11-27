import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCtx, getSetting } from "../src/core/context";
import {
  getMediaRecord, importMediaFromUrl, listMedia, serveMedia, updateMedia, uploadMedia, uploadMediaBase64,
} from "../src/core/media";
import { mediaUrl } from "../src/core/present";
import { fixtures } from "./fixtures/images";

const admin = () => createCtx(env, "https://cms.test", "admin");
const pub = () => createCtx(env, "https://cms.test", "public");
const reader = () => createCtx(env, "https://cms.test", "read");
const MB20 = 20 * 1024 * 1024;
const version = async () => Number((await getSetting(admin(), "content_version")) ?? 0);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

afterEach(() => vi.restoreAllMocks());

describe("uploadMedia", () => {
  it("can be uploaded and served (Japanese filename)", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "お知らせ 画像.png", alt: "冬" });
    expect(m).toMatchObject({ width: 1, height: 1, mimeType: "image/png", alt: "冬", filename: "お知らせ 画像.png", size: fixtures.png.length });
    expect(m.id).toMatch(/^m_[0-9a-z]{12}$/);
    const res = await SELF.fetch(mediaUrl("https://cms.test", m));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename*=UTF-8''${encodeURIComponent("お知らせ 画像.png")}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.png);
  });
  it("the R2 key is media/<id>", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.gif, filename: "a.gif" });
    expect(await env.MEDIA.head(`media/${m.id}`)).not.toBeNull();
  });
  it("over 20MB gives payload_too_large", async () => {
    await expect(uploadMedia(admin(), { bytes: new Uint8Array(MB20 + 1), filename: "big.bin" }))
      .rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("exactly 20MB is accepted", async () => {
    const m = await uploadMedia(admin(), { bytes: new Uint8Array(MB20), filename: "big.bin" });
    expect(m.size).toBe(MB20);
  });
  it("public cannot upload", async () => {
    await expect(uploadMedia(pub(), { bytes: fixtures.png, filename: "a.png" })).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("the read role gets forbidden", async () => {
    await expect(uploadMedia(reader(), { bytes: fixtures.png, filename: "a.png" })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("without mimeType it is inferred from the extension, and octet-stream if unknown", async () => {
    expect((await uploadMedia(admin(), { bytes: fixtures.jpeg, filename: "x.JPG" })).mimeType).toBe("image/jpeg");
    expect((await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: "x.unknownext" })).mimeType).toBe("application/octet-stream");
    expect((await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: "noext" })).mimeType).toBe("application/octet-stream");
  });
  it("mimeType is lowercased and its parameters are dropped; if its format is invalid it is inferred from the extension", async () => {
    expect((await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: "a.txt", mimeType: "Text/Plain; charset=utf-8" })).mimeType).toBe("text/plain");
    expect((await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png", mimeType: "nonsense" })).mimeType).toBe("image/png");
  });
  it("width/height are null for non-images", async () => {
    const m = await uploadMedia(admin(), { bytes: new Uint8Array([1, 2]), filename: "a.pdf" });
    expect(m).toMatchObject({ mimeType: "application/pdf", width: null, height: null, alt: "" });
  });
  it("path separators and control characters are removed from the filename, Japanese is kept, and it is truncated to 200 characters", async () => {
    const a = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a/b\\c\u0000\n.png" });
    expect(a.filename).toBe("abc.png");
    const j = await uploadMedia(admin(), { bytes: fixtures.png, filename: "日本語のファイル.png" });
    expect(j.filename).toBe("日本語のファイル.png");
    const long = await uploadMedia(admin(), { bytes: fixtures.png, filename: `${"あ".repeat(300)}.png` });
    expect([...long.filename]).toHaveLength(200);
    expect(long.filename.endsWith(".png")).toBe(true);
    expect((await uploadMedia(admin(), { bytes: fixtures.png, filename: "///" })).filename).toBe("file");
    expect((await uploadMedia(admin(), { bytes: fixtures.png, filename: ".." })).filename).toBe("file");
  });
  it("an unpaired surrogate is replaced with U+FFFD (a paired emoji is kept)", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "\ud800x\udc00😀.png" });
    expect(m.filename).toBe("\ufffdx\ufffd😀.png");
  });
  it("a write raises content_version", async () => {
    const before = await version();
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    expect(await version()).toBe(before + 1);
  });
  it("internal.id can overwrite the same id (both R2 and the row)", async () => {
    const first = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png", alt: "x" }, { id: "m_aaaaaaaaaaaa" });
    expect(first.id).toBe("m_aaaaaaaaaaaa");
    const second = await uploadMedia(admin(), { bytes: fixtures.gif, filename: "b.gif" }, { id: "m_aaaaaaaaaaaa" });
    expect(second).toMatchObject({ id: "m_aaaaaaaaaaaa", filename: "b.gif", mimeType: "image/gif", size: fixtures.gif.length });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media").first<{ n: number }>())!.n).toBe(1);
    const res = await serveMedia(pub(), "m_aaaaaaaaaaaa");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.gif);
  });
  it("overwriting the same id in the trash brings it back", async () => {
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_bbbbbbbbbbbb" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = 'm_bbbbbbbbbbbb'").run();
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_bbbbbbbbbbbb" });
    await expect(getMediaRecord(admin(), "m_bbbbbbbbbbbb")).resolves.toBeTruthy();
  });
});

describe("uploadMedia: when the D1 write fails (no orphan is left in R2)", () => {
  /** An admin ctx whose INSERT INTO media fails. */
  const failingInsert = () => {
    const ctx = admin();
    const db = new Proxy(ctx.db, { get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (p === "prepare") {
        return (sql: string) => {
          if (/^INSERT INTO media/i.test(sql)) throw new Error("D1_ERROR: simulated");
          return t.prepare(sql);
        };
      }
      return typeof v === "function" ? v.bind(t) : v;
    } });
    return { ...ctx, db } as typeof ctx;
  };
  const keys = async () => (await env.MEDIA.list({ prefix: "media/" })).objects.map((o) => o.key);

  it("for a new id, the R2 object is deleted and then the original error is thrown", async () => {
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.png, filename: "a.png" })).rejects.toThrow("simulated");
    expect(await keys()).toEqual([]);
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_cccccccccccc" })).rejects.toThrow("simulated");
    expect(await keys()).toEqual([]);
  });

  it("if a row or R2 object with the same id already existed (import overwrite), the object is not deleted", async () => {
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_dddddddddddd" });
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.gif, filename: "b.gif" }, { id: "m_dddddddddddd" })).rejects.toThrow("simulated");
    expect(await keys()).toEqual(["media/m_dddddddddddd"]);

    await env.MEDIA.put("media/m_eeeeeeeeeeee", fixtures.png); // R2 only, no row (CLI import PUT before a failed import)
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.gif, filename: "b.gif" }, { id: "m_eeeeeeeeeeee" })).rejects.toThrow("simulated");
    expect(await keys()).toContain("media/m_eeeeeeeeeeee");
  });
});

describe("uploadMediaBase64", () => {
  it("can be saved from base64", async () => {
    const m = await uploadMediaBase64(admin(), { base64: b64(fixtures.png), filename: "a.png" });
    expect(m).toMatchObject({ width: 1, height: 1, mimeType: "image/png", size: fixtures.png.length });
  });
  it("accepts a data URL prefix and line breaks, and picks up the mime type", async () => {
    const m = await uploadMediaBase64(admin(), { base64: `data:image/gif;base64,${b64(fixtures.gif).replace(/(.{20})/g, "$1\n")}`, filename: "noext" });
    expect(m).toMatchObject({ mimeType: "image/gif", width: 1, height: 1 });
  });
  it("invalid base64 gives bad_request", async () => {
    await expect(uploadMediaBase64(admin(), { base64: "***not base64***", filename: "a.png" })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("base64 with broken padding gives bad_request, not 500", async () => {
    for (const base64 of ["AA=", "A==", "AAAAA==", "A", "AAAAA"]) {
      await expect(uploadMediaBase64(admin(), { base64, filename: "a.bin" })).rejects.toMatchObject({ code: "bad_request" });
    }
  });
  it("base64 without padding is accepted", async () => {
    const m = await uploadMediaBase64(admin(), { base64: "AAA", filename: "a.bin" });
    expect(m.size).toBe(2);
  });
  it("base64 over 20MB gives payload_too_large", async () => {
    await expect(uploadMediaBase64(admin(), { base64: "A".repeat(Math.ceil(((MB20 + 1) * 4) / 3) + 4), filename: "big.bin" }))
      .rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("not allowed for public", async () => {
    await expect(uploadMediaBase64(pub(), { base64: b64(fixtures.png), filename: "a.png" })).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("importMediaFromUrl", () => {
  const mockFetch = (res: Response | (() => Response)) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => (typeof res === "function" ? res() : res));
  const png = () => new Response(fixtures.png, { headers: { "content-type": "image/png" } });

  it("imports from a URL; the filename is the last segment of the URL (decoded)", async () => {
    const spy = mockFetch(png);
    const m = await importMediaFromUrl(admin(), { url: "https://example.com/img/%E5%86%AC%E3%81%AE%E7%94%BB%E5%83%8F.png?x=1", alt: "冬" });
    expect(spy).toHaveBeenCalledOnce();
    expect(m).toMatchObject({ filename: "冬の画像.png", mimeType: "image/png", width: 1, height: 1, alt: "冬" });
    expect((await env.MEDIA.head(`media/${m.id}`))?.size).toBe(fixtures.png.length);
  });
  it("an explicit filename wins, and without a last segment it is file", async () => {
    mockFetch(png);
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/a.png", filename: "mine.png" })).filename).toBe("mine.png");
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/" })).filename).toBe("file");
  });
  it("with no or a generic Content-Type, it is inferred from the extension", async () => {
    mockFetch(() => new Response(fixtures.jpeg, { headers: { "content-type": "application/octet-stream" } }));
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/a.jpg" })).mimeType).toBe("image/jpeg");
  });
  it("Content-Type parameters are dropped", async () => {
    mockFetch(() => new Response("hi", { headers: { "content-type": "text/plain; charset=utf-8" } }));
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/a.txt" })).mimeType).toBe("text/plain");
  });
  it("anything other than http/https gives bad_request (no fetch)", async () => {
    const spy = mockFetch(png);
    for (const url of ["ftp://example.com/a.png", "file:///etc/passwd", "not a url"]) {
      await expect(importMediaFromUrl(admin(), { url })).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it("a failed fetch gives bad_request, with the status in the hint", async () => {
    mockFetch(() => new Response("nope", { status: 404 }));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/a.png" }))
      .rejects.toMatchObject({ code: "bad_request", hint: expect.stringContaining("404") });
  });
  it("a network error also gives bad_request", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("boom"));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/a.png" }))
      .rejects.toMatchObject({ code: "bad_request", hint: expect.stringContaining("boom") });
  });
  it("a Content-Length over 20MB gives payload_too_large without reading the body", async () => {
    const res = new Response(new ReadableStream({ pull() { throw new Error("body must not be read"); } }, { highWaterMark: 0 }), {
      headers: { "content-length": String(MB20 + 1) },
    });
    mockFetch(res);
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/big.bin" })).rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("without Content-Length, an actual size over 20MB still gives payload_too_large (reading is stopped)", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) { pulled++; if (pulled > 100) ctl.close(); else ctl.enqueue(chunk); },
    });
    mockFetch(new Response(body));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/big.bin" })).rejects.toMatchObject({ code: "payload_too_large" });
    expect(pulled).toBeLessThan(40);
  });
  it("even if Content-Length lies (too small), the actual byte count decides", async () => {
    const chunk = new Uint8Array(MB20 + 1);
    mockFetch(new Response(new ReadableStream({ start(c) { c.enqueue(chunk); c.close(); } }), { headers: { "content-length": "10" } }));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/big.bin" })).rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("not allowed for public (no fetch)", async () => {
    const spy = mockFetch(png);
    await expect(importMediaFromUrl(pub(), { url: "https://example.com/a.png" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("updateMedia / getMediaRecord", () => {
  it("updates alt and raises content_version", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png", alt: "旧" });
    const before = await version();
    const u = await updateMedia(admin(), m.id, { alt: "新" });
    expect(u).toMatchObject({ id: m.id, alt: "新", filename: "a.png" });
    expect((await getMediaRecord(admin(), m.id)).alt).toBe("新");
    expect(await version()).toBe(before + 1);
  });
  it("a missing or trashed item gives not_found", async () => {
    await expect(updateMedia(admin(), "m_zzzzzzzzzzzz", { alt: "x" })).rejects.toMatchObject({ code: "not_found" });
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = ?").bind(m.id).run();
    await expect(getMediaRecord(admin(), m.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateMedia(admin(), m.id, { alt: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
  it("admin only", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await expect(updateMedia(pub(), m.id, { alt: "x" })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(getMediaRecord(reader(), m.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("listMedia", () => {
  const at = (iso: string) => ({ ...admin(), now: () => new Date(iso) });
  it("newest first, excludes the trash, and returns total/limit/offset", async () => {
    const a = await uploadMedia(at("2026-01-01T00:00:00.000Z"), { bytes: fixtures.png, filename: "a.png" });
    const b = await uploadMedia(at("2026-01-02T00:00:00.000Z"), { bytes: fixtures.png, filename: "b.png" });
    const c = await uploadMedia(at("2026-01-03T00:00:00.000Z"), { bytes: fixtures.png, filename: "c.png" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = ?").bind(b.id).run();
    const r = await listMedia(admin(), {});
    expect(r).toMatchObject({ total: 2, limit: 10, offset: 0 });
    expect(r.items.map((m) => m.id)).toEqual([c.id, a.id]);
  });
  it("limit / offset slice the list, and limit is capped at 100", async () => {
    for (let i = 1; i <= 3; i++) await uploadMedia(at(`2026-01-0${i}T00:00:00.000Z`), { bytes: fixtures.png, filename: `${i}.png` });
    const r = await listMedia(admin(), { limit: 1, offset: 1 });
    expect(r).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(r.items.map((m) => m.filename)).toEqual(["2.png"]);
    expect((await listMedia(admin(), { limit: 1000 })).limit).toBe(100);
  });
  it("admin only", async () => {
    await expect(listMedia(pub(), {})).rejects.toMatchObject({ code: "unauthorized" });
    await expect(listMedia(reader(), {})).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("serveMedia / GET /media/:id/:filename", () => {
  it("the filename part is ignored and the id is used for lookup", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    const res = await SELF.fetch(`https://cms.test/media/${m.id}/anything-else.png`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.png);
    expect((await SELF.fetch(`https://cms.test/media/${m.id}`)).status).toBe(200);
  });
  it("a missing or trashed item gives 404", async () => {
    expect((await SELF.fetch("https://cms.test/media/m_zzzzzzzzzzzz/a.png")).status).toBe(404);
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = ?").bind(m.id).run();
    const res = await SELF.fetch(mediaUrl("https://cms.test", m));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
  it("a row without a body in R2 gives 404", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await env.MEDIA.delete(`media/${m.id}`);
    expect((await serveMedia(pub(), m.id)).status).toBe(404);
  });
  it("safe types are inline and keep their original Content-Type", async () => {
    for (const [name, mime] of [["a.pdf", "application/pdf"], ["a.mp4", "video/mp4"], ["a.mp3", "audio/mpeg"], ["a.txt", "text/plain"], ["a.webp", "image/webp"]]) {
      const m = await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: name });
      const res = await serveMedia(pub(), m.id);
      expect(res.headers.get("content-type")).toBe(mime);
      expect(res.headers.get("content-disposition")).toMatch(/^inline; /);
      await res.arrayBuffer();
    }
  });
  it("SVG / HTML / others are octet-stream attachments (not executed on the CMS origin)", async () => {
    for (const name of ["a.svg", "a.html", "a.js", "a.xml", "a.zip", "a.unknownext"]) {
      const m = await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: name });
      const res = await serveMedia(pub(), m.id);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename\*=UTF-8''/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      await res.arrayBuffer();
    }
    const spoof = await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: "x.png", mimeType: "text/html" });
    const res = await serveMedia(pub(), spoof.id);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    await res.arrayBuffer();
  });
  it("filename* in Content-Disposition is escaped per RFC 5987", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "it's (a)*.png" });
    const res = await serveMedia(pub(), m.id);
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''it%27s%20%28a%29%2A.png");
    await res.arrayBuffer();
  });
});
