import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCtx } from "../src/core/context";
import { createCollection } from "../src/core/collections";
import { createEntry, publishEntry } from "../src/core/entries";
import { renderMarkdown } from "../src/core/markdown";
import { mediaUrl, presentEntries, presentEntry, presentMedia } from "../src/core/present";
import type { Collection, EntryRecord } from "../src/core/types";

const admin = () => createCtx(env, "https://cms.test", "admin");
const pub = () => createCtx(env, "https://cms.test", "public");
const reader = () => createCtx(env, "https://cms.test", "read");

const news: Collection = {
  id: "c_000000000001", name: "news", label: null, description: null, kind: "list", public: true,
  fields: [{ name: "title", type: "text" }, { name: "body", type: "markdown" }],
  createdAt: "t", updatedAt: "t",
};
const withCover: Collection = { ...news, fields: [...news.fields, { name: "cover", type: "image" }] };

const rec = (data: Record<string, unknown>, over: Partial<EntryRecord> = {}): EntryRecord => ({
  id: "e_aaaaaaaaaaaa", collectionId: news.id, slug: null, status: "published", data,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z", ...over,
});

const insertMedia = (id: string, o: { filename?: string; deleted?: boolean } = {}) =>
  env.DB.prepare(
    "INSERT INTO media (id, filename, mime_type, size, width, height, alt, created_at, deleted_at) VALUES (?, ?, 'image/png', 10, 4, 3, '代替', 'now', ?)",
  ).bind(id, o.filename ?? "a.png", o.deleted ? "now" : null).run();

describe("renderMarkdown", () => {
  it("生 HTML（ブロック・インライン）はエスケープされる", () => {
    const h = renderMarkdown("<script>x</script>\n\ntext <b onclick=1>b</b>");
    expect(h).not.toContain("<script>");
    expect(h).not.toContain("<b ");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("&lt;b onclick=1&gt;");
  });
  it.each([
    "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x]( javascript:alert(1))", "[x](java\tscript:alert(1))",
    "[x](data:text/html,hi)", "[x](vbscript:x)", "![x](javascript:alert(1))",
    "[x][r]\n\n[r]: javascript:alert(1)",
  ])("危険な URL はリンクにならない: %s", (md) => {
    const h = renderMarkdown(md);
    expect(h).not.toMatch(/href\s*=/i);
    expect(h).not.toMatch(/src\s*=/i);
  });
  it("javascript&colon; のような実体参照は & をエスケープして無効化する", () => {
    const h = renderMarkdown("[x](javascript&colon;alert(1))");
    expect(h).toContain("javascript&amp;colon;");
    expect(h).not.toMatch(/href="javascript:/i);
  });
  it("安全な URL は残る", () => {
    const h = renderMarkdown("[a](https://e.com/x) [b](/rel) [c](mailto:a@b.c) ![i](https://e.com/i.png)");
    expect(h).toContain('href="https://e.com/x"');
    expect(h).toContain('href="/rel"');
    expect(h).toContain('href="mailto:a@b.c"');
    expect(h).toContain('src="https://e.com/i.png"');
  });
});

describe("presentEntries", () => {
  it("markdown は html に入り、生 HTML はエスケープされる", async () => {
    const [e] = await presentEntries(admin(), news, [rec({ title: "t", body: "# 見出し\n<script>x</script>" })], {});
    expect(e.data.body).toBe("# 見出し\n<script>x</script>");
    expect(e.html.body).toContain("<h1>見出し</h1>");
    expect(e.html.body).not.toContain("<script>");
  });
  it("スキーマから消えたフィールドは出さない", async () => {
    const [e] = await presentEntries(admin(), news, [rec({ title: "t", removed: 1 })], {});
    expect(e.data).not.toHaveProperty("removed");
  });
  it("型が合わない古い値でも落ちない", async () => {
    const [e] = await presentEntries(admin(), news, [rec({ title: "t", body: 123 })], {});
    expect(e.data.body).toBe(123);
    expect(e.html).not.toHaveProperty("body");
  });
  it("fields 指定時はその data キーだけ出す", async () => {
    const [e] = await presentEntries(admin(), news, [rec({ title: "t", body: "b" })], { fields: ["title"] });
    expect(Object.keys(e.data)).toEqual(["title"]);
    expect(e.html).toEqual({});
  });
  it("メタ情報がそのまま出る", async () => {
    const [e] = await presentEntries(admin(), news, [rec({}, { slug: "s" })], {});
    expect(e).toMatchObject({ id: "e_aaaaaaaaaaaa", slug: "s", status: "published", createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z" });
    expect(e).not.toHaveProperty("collectionId");
  });
  it("画像は URL 付きオブジェクトになり、日本語ファイル名はエンコードされる", async () => {
    await insertMedia("m_aaaaaaaaaaaa", { filename: "お知らせ 画像.png" });
    const [e] = await presentEntries(admin(), withCover, [rec({ title: "t", cover: "m_aaaaaaaaaaaa" })], {});
    expect(e.data.cover).toMatchObject({ id: "m_aaaaaaaaaaaa",
      url: "https://cms.test/media/m_aaaaaaaaaaaa/%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B%20%E7%94%BB%E5%83%8F.png",
      width: 4, height: 3, alt: "代替", mimeType: "image/png" });
  });
  it("ゴミ箱・不存在の画像は null、id でない古い値はそのまま", async () => {
    await insertMedia("m_bbbbbbbbbbbb", { deleted: true });
    const [a, b, c] = await presentEntries(admin(), withCover, [
      rec({ cover: "m_bbbbbbbbbbbb" }), rec({ cover: "m_cccccccccccc" }), rec({ cover: 5 }),
    ], {});
    expect(a.data.cover).toBeNull();
    expect(b.data.cover).toBeNull();
    expect(c.data.cover).toBe(5);
  });
  it("multiple の画像: ゴミ箱・不存在の要素は配列から除き、id でない古い値はそのまま", async () => {
    await insertMedia("m_aaaaaaaaaaaa");
    await insertMedia("m_bbbbbbbbbbbb", { deleted: true });
    const c: Collection = { ...news, fields: [{ name: "gallery", type: "image", multiple: true }] };
    const [a, b] = await presentEntries(admin(), c, [
      rec({ gallery: ["m_bbbbbbbbbbbb", "m_aaaaaaaaaaaa", "m_cccccccccccc"] }), rec({ gallery: ["m_aaaaaaaaaaaa", "legacy"] }),
    ], {});
    expect(a.data.gallery).toEqual([expect.objectContaining({ id: "m_aaaaaaaaaaaa" })]);
    expect(b.data.gallery).toEqual([expect.objectContaining({ id: "m_aaaaaaaaaaaa" }), "legacy"]);
  });
  it("id の形でない古い画像値はそのまま返し、問い合わせない", async () => {
    const [e] = await presentEntries(admin(), withCover, [rec({ cover: "legacy-string" })], {});
    expect(e.data.cover).toBe("legacy-string");
  });
  it("保存されていない constructor / toString などのフィールドは出さない", async () => {
    const c: Collection = { ...news, fields: [
      { name: "constructor", type: "text" }, { name: "toString", type: "markdown" },
      { name: "valueOf", type: "image" }, { name: "hasOwnProperty", type: "reference", collection: "news" } ] };
    const [e] = await presentEntries(admin(), c, [rec({ title: "x" })], { expand: ["hasOwnProperty"] });
    expect(e.data).toEqual({});
    expect(e.html).toEqual({});
    const [s] = await presentEntries(admin(), c, [rec({ constructor: "stored" })], {});
    expect(s.data).toEqual({ constructor: "stored" });
  });
  it("画像のクエリは複数レコードでも1回にまとまる", async () => {
    await insertMedia("m_aaaaaaaaaaaa");
    await insertMedia("m_bbbbbbbbbbbb");
    const ctx = admin();
    let prepared: string[] = [];
    const db = ctx.db;
    const spy = { ...ctx, db: new Proxy(db, { get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (p === "prepare") return (sql: string) => { prepared.push(sql); return t.prepare(sql); };
      return typeof v === "function" ? v.bind(t) : v;
    } }) } as typeof ctx;
    await presentEntries(spy, withCover, [
      rec({ cover: "m_aaaaaaaaaaaa" }), rec({ cover: "m_bbbbbbbbbbbb" }), rec({ cover: "m_aaaaaaaaaaaa" }),
    ], {});
    expect(prepared.filter(s => /FROM media/i.test(s))).toHaveLength(1);
    prepared = [];
    await presentEntries(spy, news, [rec({ title: "x" })], {});
    expect(prepared).toHaveLength(0);
  });
  it("list の中の画像も ApiMedia になり、参照は id のまま（参照先が無ければ null）", async () => {
    await insertMedia("m_aaaaaaaaaaaa");
    await createCollection(admin(), { name: "news", fields: [{ name: "title", type: "text" }] });
    const target = await createEntry(admin(), "news", { data: { title: "t" } });
    const c: Collection = { ...news, fields: [{ name: "items", type: "list", fields: [
      { name: "pic", type: "image" }, { name: "ref", type: "reference", collection: "news" }, { name: "t", type: "markdown" } ] }] };
    const [e] = await presentEntries(admin(), c, [rec({ items: [
      { pic: "m_aaaaaaaaaaaa", ref: target.id, t: "# x", gone: 1 }, { ref: "e_zzzzzzzzzzzz" },
    ] })], {});
    const [item, missing] = e.data.items as Array<Record<string, unknown>>;
    expect(item.pic).toMatchObject({ id: "m_aaaaaaaaaaaa" });
    expect(item.ref).toBe(target.id);
    expect(item.t).toBe("# x");
    expect(item).not.toHaveProperty("gone");
    expect(missing.ref).toBeNull();
    expect(e.html).toEqual({});
  });
  it("presentEntry は1件版", async () => {
    const e = await presentEntry(admin(), news, rec({ title: "t" }), {});
    expect(e.data).toEqual({ title: "t" });
  });
});

describe("presentMedia / mediaUrl", () => {
  it("URL とフィールド", () => {
    expect(mediaUrl("https://o", { id: "m_1", filename: "a b.png" })).toBe("https://o/media/m_1/a%20b.png");
    expect(presentMedia(admin(), { id: "m_1", filename: "a.png", mimeType: "image/png", size: 1, width: null, height: null, alt: "", createdAt: "t" }))
      .toEqual({ id: "m_1", url: "https://cms.test/media/m_1/a.png", filename: "a.png", mimeType: "image/png", size: 1,
        width: null, height: null, alt: "", createdAt: "t" });
  });
});

describe("参照の展開", () => {
  let author: EntryRecord;
  let post: Collection;
  beforeEach(async () => {
    await createCollection(admin(), { name: "authors", fields: [{ name: "name", type: "text" }, { name: "bio", type: "markdown" }, { name: "avatar", type: "image" }] });
    await createCollection(admin(), { name: "secret", public: false, fields: [{ name: "name", type: "text" }] });
    post = await createCollection(admin(), { name: "posts", fields: [
      { name: "title", type: "text" },
      { name: "author", type: "reference", collection: "authors" },
      { name: "hidden", type: "reference", collection: "secret" } ] });
    author = await createEntry(admin(), "authors", { data: { name: "山田", bio: "# hi" }, status: "published" });
  });
  const postRec = (data: Record<string, unknown>): EntryRecord => rec(data, { collectionId: post.id });

  it("既定は id 文字列、expand で ApiEntry（html 付き・さらには展開しない）", async () => {
    const [plain] = await presentEntries(pub(), post, [postRec({ author: author.id })], {});
    expect(plain.data.author).toBe(author.id);
    const [exp] = await presentEntries(pub(), post, [postRec({ author: author.id })], { expand: ["author"] });
    expect(exp.data.author).toMatchObject({ id: author.id, data: { name: "山田" } });
    expect((exp.data.author as { html: Record<string, string> }).html.bio).toContain("<h1>hi</h1>");
  });
  it("expand した参照先が下書きなら public には null、admin には出る", async () => {
    const draft = await createEntry(admin(), "authors", { data: { name: "下書き" } });
    const r = postRec({ author: draft.id });
    expect((await presentEntries(pub(), post, [r], { expand: ["author"] }))[0].data.author).toBeNull();
    expect((await presentEntries(reader(), post, [r], { expand: ["author"] }))[0].data.author).toBeNull();
    expect((await presentEntries(admin(), post, [r], { expand: ["author"] }))[0].data.author).toMatchObject({ id: draft.id });
  });
  it("multiple の参照: 既定は id の配列（存在しない要素は除く）、expand では読めない要素（下書きなど）も配列から除く", async () => {
    const multi: Collection = { ...post, fields: [{ name: "authors", type: "reference", collection: "authors", multiple: true }] };
    const draft = await createEntry(admin(), "authors", { data: { name: "下書き" } });
    const r = postRec({ authors: [draft.id, author.id, "e_nonexistent0"] });
    expect((await presentEntries(pub(), multi, [r], {}))[0].data.authors).toEqual([draft.id, author.id]);
    expect((await presentEntries(pub(), multi, [r], { expand: ["authors"] }))[0].data.authors)
      .toEqual([expect.objectContaining({ id: author.id, data: expect.objectContaining({ name: "山田" }) })]);
    expect((await presentEntries(admin(), multi, [r], { expand: ["authors"] }))[0].data.authors)
      .toEqual([expect.objectContaining({ id: draft.id }), expect.objectContaining({ id: author.id })]);
  });
  it("ゴミ箱・不存在の参照先は null", async () => {
    await env.DB.prepare("UPDATE entries SET deleted_at = 'now' WHERE id = ?").bind(author.id).run();
    expect((await presentEntries(admin(), post, [postRec({ author: author.id })], { expand: ["author"] }))[0].data.author).toBeNull();
    expect((await presentEntries(admin(), post, [postRec({ author: "e_nonexistent0" })], { expand: ["author"] }))[0].data.author).toBeNull();
  });
  it("非公開コレクションの参照先は public には null、read には出る", async () => {
    const s = await createEntry(admin(), "secret", { data: { name: "x" }, status: "published" });
    const r = postRec({ hidden: s.id });
    expect((await presentEntries(pub(), post, [r], { expand: ["hidden"] }))[0].data.hidden).toBeNull();
    expect((await presentEntries(reader(), post, [r], { expand: ["hidden"] }))[0].data.hidden).toMatchObject({ id: s.id });
  });
  it("参照先が別コレクションのエントリなら null", async () => {
    const s = await createEntry(admin(), "secret", { data: { name: "x" }, status: "published" });
    expect((await presentEntries(admin(), post, [postRec({ author: s.id })], { expand: ["author"] }))[0].data.author).toBeNull();
  });
  describe("expand なしでも、参照先が無い・ゴミ箱・ゴミ箱のコレクション・別コレクションなら null（multiple は除く）", () => {
    let gone: { trashed: string; inTrashedCollection: string; other: string };
    beforeEach(async () => {
      const t = await createEntry(admin(), "authors", { data: { name: "捨てた" }, status: "published" });
      await env.DB.prepare("UPDATE entries SET deleted_at = 'now' WHERE id = ?").bind(t.id).run();
      await createCollection(admin(), { name: "old", fields: [{ name: "name", type: "text" }] });
      const o = await createEntry(admin(), "old", { data: { name: "x" }, status: "published" });
      await env.DB.prepare("UPDATE collections SET deleted_at = 'now' WHERE name = 'old'").run();
      const s = await createEntry(admin(), "secret", { data: { name: "x" }, status: "published" });
      gone = { trashed: t.id, inTrashedCollection: o.id, other: s.id };
    });

    it("単一の参照（トップレベル）", async () => {
      const out = await presentEntries(pub(), post, [
        postRec({ author: author.id }), postRec({ author: gone.trashed }), postRec({ author: gone.other }),
        postRec({ author: "e_nonexistent0" }), postRec({ author: "legacy" }),
      ], {});
      expect(out.map((e) => e.data.author)).toEqual([author.id, null, null, null, "legacy"]);
      // the collection itself being trashed
      const oldRef: Collection = { ...post, fields: [{ name: "o", type: "reference", collection: "old" }] };
      expect((await presentEntries(admin(), oldRef, [postRec({ o: gone.inTrashedCollection })], {}))[0].data.o).toBeNull();
    });

    it("multiple と list の中", async () => {
      const c: Collection = { ...post, fields: [
        { name: "many", type: "reference", collection: "authors", multiple: true },
        { name: "rows", type: "list", fields: [{ name: "who", type: "reference", collection: "authors" }, { name: "all", type: "reference", collection: "authors", multiple: true }] },
      ] };
      const [e] = await presentEntries(admin(), c, [postRec({
        many: [gone.trashed, author.id, gone.other, "e_nonexistent0"],
        rows: [{ who: gone.trashed, all: [author.id, gone.trashed] }, { who: author.id }],
      })], {});
      expect(e.data.many).toEqual([author.id]);
      expect(e.data.rows).toEqual([{ who: null, all: [author.id] }, { who: author.id }]);
    });

    it("展開したエントリの中の参照も同じ扱い", async () => {
      await createCollection(admin(), { name: "people", fields: [
        { name: "name", type: "text" }, { name: "friend", type: "reference", collection: "authors" },
      ] });
      const p = await createEntry(admin(), "people", { data: { name: "p", friend: author.id }, status: "published" });
      await env.DB.prepare("UPDATE entries SET data = ? WHERE id = ?").bind(JSON.stringify({ name: "p", friend: gone.trashed }), p.id).run();
      const c = await createCollection(admin(), { name: "notes", fields: [{ name: "by", type: "reference", collection: "people" }] });
      const [e] = await presentEntries(admin(), c, [rec({ by: p.id }, { collectionId: c.id })], { expand: ["by"] });
      expect((e.data.by as { data: Record<string, unknown> }).data.friend).toBeNull();
    });

    it("参照の存在確認は何件あっても entries へのクエリ 1 回", async () => {
      const ctx = admin();
      const prepared: string[] = [];
      const spy = { ...ctx, db: new Proxy(ctx.db, { get(t, p) {
        const v = Reflect.get(t, p) as unknown;
        if (p === "prepare") return (sql: string) => { prepared.push(sql); return t.prepare(sql); };
        return typeof v === "function" ? v.bind(t) : v;
      } }) } as typeof ctx;
      const records = Array.from({ length: 30 }, (_, i) => postRec({ author: i % 2 ? author.id : gone.trashed }));
      const out = await presentEntries(spy, post, records, {});
      expect(out[0].data.author).toBeNull();
      expect(out[1].data.author).toBe(author.id);
      expect(prepared.filter(s => /FROM entries/i.test(s))).toHaveLength(1);
    });
  });

  it("展開した参照先の画像も解決され、クエリは media 1回・entries 1回", async () => {
    await insertMedia("m_aaaaaaaaaaaa");
    const a2 = await createEntry(admin(), "authors", { data: { name: "b", avatar: "m_aaaaaaaaaaaa" }, status: "published" });
    await publishEntry(admin(), "authors", a2.id);
    const ctx = pub();
    const prepared: string[] = [];
    const spy = { ...ctx, db: new Proxy(ctx.db, { get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (p === "prepare") return (sql: string) => { prepared.push(sql); return t.prepare(sql); };
      return typeof v === "function" ? v.bind(t) : v;
    } }) } as typeof ctx;
    const out = await presentEntries(spy, post, [postRec({ author: author.id }), postRec({ author: a2.id })], { expand: ["author"] });
    expect((out[1].data.author as { data: { avatar: unknown } }).data.avatar).toMatchObject({ id: "m_aaaaaaaaaaaa" });
    expect(prepared.filter(s => /FROM media/i.test(s))).toHaveLength(1);
    expect(prepared.filter(s => /FROM entries/i.test(s))).toHaveLength(1);
  });
});
