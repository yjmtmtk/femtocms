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
  it("アップロードして配信できる（日本語ファイル名）", async () => {
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
  it("R2 のキーは media/<id>", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.gif, filename: "a.gif" });
    expect(await env.MEDIA.head(`media/${m.id}`)).not.toBeNull();
  });
  it("20MB を超えると payload_too_large", async () => {
    await expect(uploadMedia(admin(), { bytes: new Uint8Array(MB20 + 1), filename: "big.bin" }))
      .rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("ちょうど 20MB は通る", async () => {
    const m = await uploadMedia(admin(), { bytes: new Uint8Array(MB20), filename: "big.bin" });
    expect(m.size).toBe(MB20);
  });
  it("public ではアップロードできない", async () => {
    await expect(uploadMedia(pub(), { bytes: fixtures.png, filename: "a.png" })).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("read ロールは forbidden", async () => {
    await expect(uploadMedia(reader(), { bytes: fixtures.png, filename: "a.png" })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("mimeType が無ければ拡張子から推定し、不明なら octet-stream", async () => {
    expect((await uploadMedia(admin(), { bytes: fixtures.jpeg, filename: "x.JPG" })).mimeType).toBe("image/jpeg");
    expect((await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: "x.unknownext" })).mimeType).toBe("application/octet-stream");
    expect((await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: "noext" })).mimeType).toBe("application/octet-stream");
  });
  it("mimeType は小文字化しパラメータを落とす。形式が不正なら拡張子から推定", async () => {
    expect((await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: "a.txt", mimeType: "Text/Plain; charset=utf-8" })).mimeType).toBe("text/plain");
    expect((await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png", mimeType: "nonsense" })).mimeType).toBe("image/png");
  });
  it("画像以外は width/height が null", async () => {
    const m = await uploadMedia(admin(), { bytes: new Uint8Array([1, 2]), filename: "a.pdf" });
    expect(m).toMatchObject({ mimeType: "application/pdf", width: null, height: null, alt: "" });
  });
  it("ファイル名から区切り文字と制御文字を除き、日本語は残し、200 文字に切り詰める", async () => {
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
  it("ペアになっていないサロゲートは U+FFFD に置き換える（ペアの絵文字は残す）", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "\ud800x\udc00😀.png" });
    expect(m.filename).toBe("\ufffdx\ufffd😀.png");
  });
  it("書き込みで content_version が上がる", async () => {
    const before = await version();
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    expect(await version()).toBe(before + 1);
  });
  it("internal.id で同じ id を上書きできる（R2 も行も）", async () => {
    const first = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png", alt: "x" }, { id: "m_aaaaaaaaaaaa" });
    expect(first.id).toBe("m_aaaaaaaaaaaa");
    const second = await uploadMedia(admin(), { bytes: fixtures.gif, filename: "b.gif" }, { id: "m_aaaaaaaaaaaa" });
    expect(second).toMatchObject({ id: "m_aaaaaaaaaaaa", filename: "b.gif", mimeType: "image/gif", size: fixtures.gif.length });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media").first<{ n: number }>())!.n).toBe(1);
    const res = await serveMedia(pub(), "m_aaaaaaaaaaaa");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.gif);
  });
  it("ゴミ箱の同じ id に上書きすると復活する", async () => {
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_bbbbbbbbbbbb" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = 'm_bbbbbbbbbbbb'").run();
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_bbbbbbbbbbbb" });
    await expect(getMediaRecord(admin(), "m_bbbbbbbbbbbb")).resolves.toBeTruthy();
  });
});

describe("uploadMedia: D1 への書き込みが失敗したとき (R2 に孤児を残さない)", () => {
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

  it("新しい id なら R2 のオブジェクトを消してから元のエラーを投げる", async () => {
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.png, filename: "a.png" })).rejects.toThrow("simulated");
    expect(await keys()).toEqual([]);
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_cccccccccccc" })).rejects.toThrow("simulated");
    expect(await keys()).toEqual([]);
  });

  it("同じ id の行か R2 オブジェクトが前からあれば（import の上書き）、オブジェクトは消さない", async () => {
    await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" }, { id: "m_dddddddddddd" });
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.gif, filename: "b.gif" }, { id: "m_dddddddddddd" })).rejects.toThrow("simulated");
    expect(await keys()).toEqual(["media/m_dddddddddddd"]);

    await env.MEDIA.put("media/m_eeeeeeeeeeee", fixtures.png); // R2 only, no row (CLI import PUT before a failed import)
    await expect(uploadMedia(failingInsert(), { bytes: fixtures.gif, filename: "b.gif" }, { id: "m_eeeeeeeeeeee" })).rejects.toThrow("simulated");
    expect(await keys()).toContain("media/m_eeeeeeeeeeee");
  });
});

describe("uploadMediaBase64", () => {
  it("base64 から保存できる", async () => {
    const m = await uploadMediaBase64(admin(), { base64: b64(fixtures.png), filename: "a.png" });
    expect(m).toMatchObject({ width: 1, height: 1, mimeType: "image/png", size: fixtures.png.length });
  });
  it("data URL の接頭辞と改行を許容し、mime を拾う", async () => {
    const m = await uploadMediaBase64(admin(), { base64: `data:image/gif;base64,${b64(fixtures.gif).replace(/(.{20})/g, "$1\n")}`, filename: "noext" });
    expect(m).toMatchObject({ mimeType: "image/gif", width: 1, height: 1 });
  });
  it("不正な base64 は bad_request", async () => {
    await expect(uploadMediaBase64(admin(), { base64: "***not base64***", filename: "a.png" })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("パディングが壊れた base64 は 500 ではなく bad_request", async () => {
    for (const base64 of ["AA=", "A==", "AAAAA==", "A", "AAAAA"]) {
      await expect(uploadMediaBase64(admin(), { base64, filename: "a.bin" })).rejects.toMatchObject({ code: "bad_request" });
    }
  });
  it("パディング無しの base64 は受け付ける", async () => {
    const m = await uploadMediaBase64(admin(), { base64: "AAA", filename: "a.bin" });
    expect(m.size).toBe(2);
  });
  it("20MB を超える base64 は payload_too_large", async () => {
    await expect(uploadMediaBase64(admin(), { base64: "A".repeat(Math.ceil(((MB20 + 1) * 4) / 3) + 4), filename: "big.bin" }))
      .rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("public では不可", async () => {
    await expect(uploadMediaBase64(pub(), { base64: b64(fixtures.png), filename: "a.png" })).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("importMediaFromUrl", () => {
  const mockFetch = (res: Response | (() => Response)) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => (typeof res === "function" ? res() : res));
  const png = () => new Response(fixtures.png, { headers: { "content-type": "image/png" } });

  it("URL から取り込む。ファイル名は URL の最後のセグメント（デコード済み）", async () => {
    const spy = mockFetch(png);
    const m = await importMediaFromUrl(admin(), { url: "https://example.com/img/%E5%86%AC%E3%81%AE%E7%94%BB%E5%83%8F.png?x=1", alt: "冬" });
    expect(spy).toHaveBeenCalledOnce();
    expect(m).toMatchObject({ filename: "冬の画像.png", mimeType: "image/png", width: 1, height: 1, alt: "冬" });
    expect((await env.MEDIA.head(`media/${m.id}`))?.size).toBe(fixtures.png.length);
  });
  it("filename 指定が優先され、最後のセグメントが無ければ file", async () => {
    mockFetch(png);
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/a.png", filename: "mine.png" })).filename).toBe("mine.png");
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/" })).filename).toBe("file");
  });
  it("Content-Type が無い・汎用のときは拡張子から推定", async () => {
    mockFetch(() => new Response(fixtures.jpeg, { headers: { "content-type": "application/octet-stream" } }));
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/a.jpg" })).mimeType).toBe("image/jpeg");
  });
  it("Content-Type のパラメータは落とす", async () => {
    mockFetch(() => new Response("hi", { headers: { "content-type": "text/plain; charset=utf-8" } }));
    expect((await importMediaFromUrl(admin(), { url: "https://example.com/a.txt" })).mimeType).toBe("text/plain");
  });
  it("http/https 以外は bad_request（fetch しない）", async () => {
    const spy = mockFetch(png);
    for (const url of ["ftp://example.com/a.png", "file:///etc/passwd", "not a url"]) {
      await expect(importMediaFromUrl(admin(), { url })).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it("取得失敗は bad_request で、ステータスを hint に入れる", async () => {
    mockFetch(() => new Response("nope", { status: 404 }));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/a.png" }))
      .rejects.toMatchObject({ code: "bad_request", hint: expect.stringContaining("404") });
  });
  it("ネットワークエラーも bad_request", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("boom"));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/a.png" }))
      .rejects.toMatchObject({ code: "bad_request", hint: expect.stringContaining("boom") });
  });
  it("Content-Length が 20MB 超なら本体を読まずに payload_too_large", async () => {
    const res = new Response(new ReadableStream({ pull() { throw new Error("body must not be read"); } }, { highWaterMark: 0 }), {
      headers: { "content-length": String(MB20 + 1) },
    });
    mockFetch(res);
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/big.bin" })).rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("Content-Length が無くても実際のバイト数が 20MB 超なら payload_too_large（読み込みを止める）", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) { pulled++; if (pulled > 100) ctl.close(); else ctl.enqueue(chunk); },
    });
    mockFetch(new Response(body));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/big.bin" })).rejects.toMatchObject({ code: "payload_too_large" });
    expect(pulled).toBeLessThan(40);
  });
  it("Content-Length が嘘（小さい）でも実際のバイト数で判定する", async () => {
    const chunk = new Uint8Array(MB20 + 1);
    mockFetch(new Response(new ReadableStream({ start(c) { c.enqueue(chunk); c.close(); } }), { headers: { "content-length": "10" } }));
    await expect(importMediaFromUrl(admin(), { url: "https://example.com/big.bin" })).rejects.toMatchObject({ code: "payload_too_large" });
  });
  it("public では不可（fetch しない）", async () => {
    const spy = mockFetch(png);
    await expect(importMediaFromUrl(pub(), { url: "https://example.com/a.png" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("updateMedia / getMediaRecord", () => {
  it("alt を更新し、content_version が上がる", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png", alt: "旧" });
    const before = await version();
    const u = await updateMedia(admin(), m.id, { alt: "新" });
    expect(u).toMatchObject({ id: m.id, alt: "新", filename: "a.png" });
    expect((await getMediaRecord(admin(), m.id)).alt).toBe("新");
    expect(await version()).toBe(before + 1);
  });
  it("存在しない・ゴミ箱は not_found", async () => {
    await expect(updateMedia(admin(), "m_zzzzzzzzzzzz", { alt: "x" })).rejects.toMatchObject({ code: "not_found" });
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = ?").bind(m.id).run();
    await expect(getMediaRecord(admin(), m.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateMedia(admin(), m.id, { alt: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
  it("admin のみ", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await expect(updateMedia(pub(), m.id, { alt: "x" })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(getMediaRecord(reader(), m.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("listMedia", () => {
  const at = (iso: string) => ({ ...admin(), now: () => new Date(iso) });
  it("新しい順・ゴミ箱を除く・total/limit/offset を返す", async () => {
    const a = await uploadMedia(at("2026-01-01T00:00:00.000Z"), { bytes: fixtures.png, filename: "a.png" });
    const b = await uploadMedia(at("2026-01-02T00:00:00.000Z"), { bytes: fixtures.png, filename: "b.png" });
    const c = await uploadMedia(at("2026-01-03T00:00:00.000Z"), { bytes: fixtures.png, filename: "c.png" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = ?").bind(b.id).run();
    const r = await listMedia(admin(), {});
    expect(r).toMatchObject({ total: 2, limit: 10, offset: 0 });
    expect(r.items.map((m) => m.id)).toEqual([c.id, a.id]);
  });
  it("limit / offset で切れ、limit は最大 100 に丸める", async () => {
    for (let i = 1; i <= 3; i++) await uploadMedia(at(`2026-01-0${i}T00:00:00.000Z`), { bytes: fixtures.png, filename: `${i}.png` });
    const r = await listMedia(admin(), { limit: 1, offset: 1 });
    expect(r).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(r.items.map((m) => m.filename)).toEqual(["2.png"]);
    expect((await listMedia(admin(), { limit: 1000 })).limit).toBe(100);
  });
  it("admin のみ", async () => {
    await expect(listMedia(pub(), {})).rejects.toMatchObject({ code: "unauthorized" });
    await expect(listMedia(reader(), {})).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("serveMedia / GET /media/:id/:filename", () => {
  it("ファイル名部分は無視して id で引く", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    const res = await SELF.fetch(`https://cms.test/media/${m.id}/anything-else.png`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.png);
    expect((await SELF.fetch(`https://cms.test/media/${m.id}`)).status).toBe(200);
  });
  it("不存在・ゴミ箱は 404", async () => {
    expect((await SELF.fetch("https://cms.test/media/m_zzzzzzzzzzzz/a.png")).status).toBe(404);
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = ?").bind(m.id).run();
    const res = await SELF.fetch(mediaUrl("https://cms.test", m));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
  it("行はあるが R2 に本体が無ければ 404", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await env.MEDIA.delete(`media/${m.id}`);
    expect((await serveMedia(pub(), m.id)).status).toBe(404);
  });
  it("安全な種類は inline で、元の Content-Type のまま", async () => {
    for (const [name, mime] of [["a.pdf", "application/pdf"], ["a.mp4", "video/mp4"], ["a.mp3", "audio/mpeg"], ["a.txt", "text/plain"], ["a.webp", "image/webp"]]) {
      const m = await uploadMedia(admin(), { bytes: new Uint8Array([1]), filename: name });
      const res = await serveMedia(pub(), m.id);
      expect(res.headers.get("content-type")).toBe(mime);
      expect(res.headers.get("content-disposition")).toMatch(/^inline; /);
      await res.arrayBuffer();
    }
  });
  it("SVG / HTML / その他は octet-stream の attachment（CMS オリジンで実行させない）", async () => {
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
  it("Content-Disposition の filename* は RFC 5987 でエスケープする", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "it's (a)*.png" });
    const res = await serveMedia(pub(), m.id);
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''it%27s%20%28a%29%2A.png");
    await res.arrayBuffer();
  });
});
