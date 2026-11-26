import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollection, updateCollection } from "../src/core/collections";
import { createCtx, getSetting } from "../src/core/context";
import { createEntry, getEntryRecord } from "../src/core/entries";
import { uploadMedia } from "../src/core/media";
import { exportData, importData, resetSite, type ExportData } from "../src/core/transfer";
import { emptyTrash, listTrash, restoreFromTrash, trashCollection, trashEntry, trashMedia } from "../src/core/trash";
import { fixtures } from "./fixtures/images";

const admin = () => createCtx(env, "https://cms.test", "admin");
const reader = () => createCtx(env, "https://cms.test", "read");
const version = async () => Number((await getSetting(admin(), "content_version")) ?? 0);
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

afterEach(() => vi.restoreAllMocks());

const mockPng = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(fixtures.png, { headers: { "content-type": "image/png" } }),
  );

const newsDef = {
  name: "news", label: "お知らせ", kind: "list", public: true,
  fields: [
    { name: "title", type: "text", required: true },
    { name: "cover", type: "image" },
    { name: "related", type: "reference", collection: "news" },
  ],
} as const;

/** news + 1 image + 1 published entry with a cover and a reference to a second (draft) entry. */
async function seed() {
  await createCollection(admin(), newsDef);
  const media = await uploadMedia(admin(), { bytes: fixtures.png, filename: "cover.png", alt: "表紙" });
  const other = await createEntry(admin(), "news", { data: { title: "別の記事" }, slug: "other" });
  const entry = await createEntry(admin(), "news", {
    data: { title: "冬", cover: media.id, related: other.id }, slug: "winter", status: "published",
  });
  return { media, other, entry };
}

const emptyDump = (over: Partial<ExportData> = {}): ExportData => ({
  format: "femtocms-export", version: 1, exportedAt: "2026-11-26T00:00:00.000Z", site: "dev-site",
  collections: [], entries: [], media: [], ...over,
});

const issuesOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toMatchObject({ code: "validation_failed" });
  return (e as { issues: { path: string }[] }).issues.map((i) => i.path);
};

describe("exportData", () => {
  it("コレクション定義・エントリ・メディアを出し、ゴミ箱・settings・api_keys は含めない", async () => {
    const { media, entry, other } = await seed();
    await createCollection(admin(), { name: "gone", fields: [] });
    await trashCollection(admin(), "gone");
    const trashed = await createEntry(admin(), "news", { data: { title: "x" } });
    await trashEntry(admin(), "news", trashed.id);
    const dump = await exportData(admin());
    expect(dump).toMatchObject({ format: "femtocms-export", version: 1, site: "dev-site" });
    expect(dump.collections).toEqual([{ ...newsDef, fields: [...newsDef.fields] }]);
    expect(dump.entries.map((e) => e.id).sort()).toEqual([entry.id, other.id].sort());
    expect(dump.entries.find((e) => e.id === entry.id)).toEqual({
      id: entry.id, collection: "news", slug: "winter", status: "published",
      data: { title: "冬", cover: media.id, related: other.id },
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, publishedAt: entry.publishedAt,
    });
    expect(dump.media).toEqual([{ ...media, url: `https://cms.test/media/${media.id}/cover.png` }]);
    expect(JSON.stringify(dump)).not.toMatch(/preview_secret|content_version|api_keys|hash/);
  });
  describe("どんな状態のサイトでも export -> import で戻せる (R11)", () => {
    const roundTrip = async () => {
      const dump = await exportData(admin());
      await resetSite(admin(), "dev-site");
      await emptyTrash(admin(), "dev-site");
      mockPng();
      await importData(admin(), { data: dump, mode: "merge" });
      return dump;
    };

    it("ゴミ箱・完全削除されたメディア / エントリを指す値は出さない", async () => {
      const { media, entry, other } = await seed();
      await trashMedia(admin(), media.id);
      const dump = await roundTrip();
      expect(dump.media).toEqual([]);
      expect(dump.entries.find((e) => e.id === entry.id)!.data).toEqual({ title: "冬", related: other.id });
      expect((await getEntryRecord(admin(), "news", entry.id)).data).toEqual({ title: "冬", related: other.id });
    });
    it("参照先エントリがゴミ箱にある場合も同様", async () => {
      const { entry, other } = await seed();
      await trashEntry(admin(), "news", other.id);
      const dump = await roundTrip();
      expect(dump.entries.map((e) => e.id)).toEqual([entry.id]);
      expect(dump.entries[0].data).toMatchObject({ title: "冬" });
      expect(dump.entries[0].data).not.toHaveProperty("related");
    });
    it("list の中の宙に浮いた参照だけを落とし、他の値は残す", async () => {
      const media = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
      const gone = await uploadMedia(admin(), { bytes: fixtures.png, filename: "b.png" });
      await createCollection(admin(), {
        name: "page", fields: [{ name: "items", type: "list", fields: [{ name: "img", type: "image" }, { name: "t", type: "text" }] }],
      });
      await createEntry(admin(), "page", { data: { items: [{ img: media.id, t: "1" }, { img: gone.id, t: "2" }] } });
      await trashMedia(admin(), gone.id);
      const dump = await roundTrip();
      expect(dump.entries[0].data).toEqual({ items: [{ img: media.id, t: "1" }, { t: "2" }] });
    });
    it("multiple の gallery は宙に浮いた要素だけを落とし、配列は残す", async () => {
      const a = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
      const b = await uploadMedia(admin(), { bytes: fixtures.png, filename: "b.png" });
      await createCollection(admin(), { name: "album", fields: [{ name: "gallery", type: "image", multiple: true }] });
      const e = await createEntry(admin(), "album", { data: { gallery: [a.id, b.id] } });
      await trashMedia(admin(), b.id);
      const dump = await roundTrip();
      expect(dump.entries[0].data).toEqual({ gallery: [a.id] });
      expect((await getEntryRecord(admin(), "album", e.id)).data).toEqual({ gallery: [a.id] });
    });
    it("公開後に required のフィールドを足しても戻せる", async () => {
      const { entry } = await seed();
      await updateCollection(admin(), "news", { fields: [...newsDef.fields, { name: "subtitle", type: "text", required: true }] });
      await roundTrip();
      const e = await getEntryRecord(admin(), "news", entry.id);
      expect(e.status).toBe("published");
      expect(e.data).not.toHaveProperty("subtitle");
    });
    it("フィールドの型を変えて保存値が合わなくなっても、その値を除いて戻せる", async () => {
      await createCollection(admin(), { name: "page", fields: [{ name: "n", type: "text" }, { name: "keep", type: "text" }] });
      const e = await createEntry(admin(), "page", { data: { n: "abc", keep: "ok" } });
      await updateCollection(admin(), "page", { fields: [{ name: "n", type: "number" }, { name: "keep", type: "text" }] });
      const dump = await roundTrip();
      expect(dump.entries[0].data).toEqual({ keep: "ok" });
      expect((await getEntryRecord(admin(), "page", e.id)).data).toEqual({ keep: "ok" });
    });
  });
  it("スキーマから消えたフィールドの値（古いキー）は出さず、そのまま取り込める（list の中も同様）", async () => {
    await createCollection(admin(), {
      name: "page",
      fields: [
        { name: "title", type: "text" }, { name: "old", type: "text" },
        { name: "items", type: "list", fields: [{ name: "a", type: "text" }, { name: "b", type: "text" }] },
      ],
    });
    const e = await createEntry(admin(), "page", { data: { title: "t", old: "x", items: [{ a: "1", b: "2" }] } });
    await updateCollection(admin(), "page", {
      fields: [{ name: "title", type: "text" }, { name: "items", type: "list", fields: [{ name: "a", type: "text" }] }],
    });
    const stored = await env.DB.prepare("SELECT data FROM entries WHERE id = ?").bind(e.id).first<{ data: string }>();
    expect(JSON.parse(stored!.data)).toMatchObject({ old: "x" }); // R1: still stored
    const dump = await exportData(admin());
    expect(dump.entries[0].data).toEqual({ title: "t", items: [{ a: "1" }] });
    await resetSite(admin(), "dev-site");
    await emptyTrash(admin(), "dev-site");
    await importData(admin(), { data: dump, mode: "merge" });
    expect((await getEntryRecord(admin(), "page", e.id)).data).toEqual({ title: "t", items: [{ a: "1" }] });
  });
  it("admin 以外は不可", async () => {
    await expect(exportData(reader())).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("importData", () => {
  it("export したものを空にしたサイトへ merge で取り込むと同じ内容になる", async () => {
    await seed();
    const dump = await exportData(admin());
    await resetSite(admin(), "dev-site");
    await emptyTrash(admin(), "dev-site");
    expect(await count("collections")).toBe(0);
    const spy = mockPng();
    const before = await version();
    const r = await importData(admin(), { data: dump, mode: "merge" });
    expect(r).toEqual({ collections: 1, entries: 2, media: 1 });
    expect(spy).toHaveBeenCalledWith(dump.media[0].url, expect.anything());
    expect(await exportData(admin())).toMatchObject({ collections: dump.collections, entries: dump.entries, media: dump.media });
    expect(await version()).toBe(before + 1);
    expect((await env.MEDIA.head(`media/${dump.media[0].id}`))?.size).toBe(fixtures.png.byteLength);
    expect((await getEntryRecord(admin(), "news", "winter")).status).toBe("published");
  });
  it("日時は ISO 8601 (UTC, ミリ秒付き) にそろえ、公開済みで publishedAt が null なら updatedAt を使う", async () => {
    await createCollection(admin(), newsDef);
    const entry = (id: string, over: Record<string, unknown>) => ({
      id, collection: "news", slug: null, status: "published", data: { title: "t" },
      createdAt: "2026-01-02T03:04:05+09:00", updatedAt: "2026-01-03", publishedAt: "2026-01-02T12:00Z", ...over,
    });
    const dump = emptyDump({
      entries: [entry("e_aaaaaaaaaaa1", {}), entry("e_aaaaaaaaaaa2", { publishedAt: null }), entry("e_aaaaaaaaaaa3", { status: "draft", publishedAt: null })] as never,
    });
    await importData(admin(), { data: dump, mode: "merge" });
    const [a, b, c] = await Promise.all(["e_aaaaaaaaaaa1", "e_aaaaaaaaaaa2", "e_aaaaaaaaaaa3"].map((id) => getEntryRecord(admin(), "news", id)));
    expect(a).toMatchObject({ createdAt: "2026-01-01T18:04:05.000Z", updatedAt: "2026-01-03T00:00:00.000Z", publishedAt: "2026-01-02T12:00:00.000Z" });
    expect(b.publishedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(c.publishedAt).toBeNull();
  });
  it("merge は既存を上書きし、ゴミ箱のものは戻す。同名コレクションは定義を上書きして id を保つ", async () => {
    const { entry } = await seed();
    const dump = await exportData(admin());
    const colId = (await env.DB.prepare("SELECT id FROM collections WHERE name = 'news'").first<{ id: string }>())!.id;
    await trashCollection(admin(), "news");
    const edited = structuredClone(dump);
    edited.collections[0].label = "更新後";
    edited.entries.find((e) => e.id === entry.id)!.data.title = "春";
    await importData(admin(), { data: edited, mode: "merge" });
    const c = await env.DB.prepare("SELECT * FROM collections WHERE name = 'news'").first<Record<string, unknown>>();
    expect(c).toMatchObject({ id: colId, label: "更新後", deleted_at: null });
    const row = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(entry.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ deleted_at: null, trashed_with: null });
    expect(JSON.parse(row!.data as string).title).toBe("春");
    expect(await listTrash(admin())).toEqual([]);
  });
  it("コレクションをゴミ箱から戻す際、取り込みに無いエントリはゴミ箱に残る", async () => {
    const { entry, other } = await seed();
    const dump = await exportData(admin());
    await trashCollection(admin(), "news");
    dump.entries = dump.entries.filter((e) => e.id === entry.id);
    dump.entries[0].data = { title: "冬" };
    await importData(admin(), { data: dump, mode: "merge" });
    expect(await listTrash(admin())).toEqual([expect.objectContaining({ type: "entry", id: other.id })]);
    await restoreFromTrash(admin(), other.id);
  });
  it("replace は confirm が要り（何もしない）、既存はゴミ箱に入る", async () => {
    await seed();
    await expect(importData(admin(), { data: emptyDump(), mode: "replace" })).rejects.toMatchObject({ code: "confirmation_required" });
    expect(await listTrash(admin())).toEqual([]);
    const v = await version();
    expect(await importData(admin(), { data: emptyDump(), mode: "replace", confirm: "dev-site" }))
      .toEqual({ collections: 0, entries: 0, media: 0 });
    expect((await listTrash(admin())).length).toBeGreaterThan(0);
    expect(await count("collections")).toBe(1);
    expect(await version()).toBe(v + 1);
  });
  it("replace: 既存と同じ id のものは戻って上書きされ、残りはゴミ箱に残る", async () => {
    const { entry, other, media } = await seed();
    const dump = await exportData(admin());
    dump.entries = dump.entries.filter((e) => e.id === entry.id);
    dump.entries[0].data = { title: "冬", cover: media.id };
    await importData(admin(), { data: dump, mode: "replace", confirm: "dev-site" });
    expect((await getEntryRecord(admin(), "news", entry.id)).data).toEqual({ title: "冬", cover: media.id });
    const trash = await listTrash(admin());
    expect(trash).toEqual([expect.objectContaining({ type: "entry", id: other.id })]);
    expect((await exportData(admin())).media.map((m) => m.id)).toEqual([media.id]);
  });
  it("url が無いメディアは R2 に同じ id のファイルがあれば行だけ作る。無ければ issue", async () => {
    const { media } = await seed();
    const dump = await exportData(admin());
    const spy = vi.spyOn(globalThis, "fetch");
    delete (dump.media[0] as Partial<typeof dump.media[0]>).url;
    await env.DB.prepare("DELETE FROM entries").run();
    await env.DB.prepare("DELETE FROM media").run();
    await importData(admin(), { data: dump, mode: "merge" });
    expect(spy).not.toHaveBeenCalled();
    expect((await exportData(admin())).media).toEqual([expect.objectContaining({ id: media.id, filename: "cover.png", alt: "表紙" })]);

    await env.MEDIA.delete(`media/${media.id}`);
    expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["media[0].url"]);
  });
  it("url が無い / 自サイトのメディアも、他のアップロードと同じ清掃をし、size は R2 から取る", async () => {
    const { media } = await seed();
    const dump = await exportData(admin());
    Object.assign(dump.media[0], { filename: "a\u2028b\u0001/c.png", mimeType: "not a mime", size: 999999 });
    delete (dump.media[0] as Partial<typeof dump.media[0]>).url;
    await importData(admin(), { data: dump, mode: "merge" });
    expect((await exportData(admin())).media[0]).toMatchObject({
      id: media.id, filename: "abc.png", mimeType: "image/png", size: fixtures.png.byteLength,
    });
    // same-origin url (no fetch) is treated the same way
    dump.media[0].url = `https://cms.test/media/${media.id}/x.png`;
    dump.media[0].filename = "d\u0000.jpg";
    dump.media[0].mimeType = "";
    const spy = vi.spyOn(globalThis, "fetch");
    await importData(admin(), { data: dump, mode: "merge" });
    expect(spy).not.toHaveBeenCalled();
    expect((await exportData(admin())).media[0]).toMatchObject({ filename: "d.jpg", mimeType: "image/jpeg", size: fixtures.png.byteLength });
  });
  it("R2 の確認はメディアごとの head ではなく media/ の list をページごとにまとめて行う", async () => {
    await createCollection(admin(), newsDef);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await uploadMedia(admin(), { bytes: fixtures.png, filename: `p${i}.png` })).id);
    const dump = await exportData(admin());
    for (const m of dump.media) delete (m as Partial<typeof m>).url;
    await env.DB.prepare("DELETE FROM media").run();

    const ctx = admin();
    const calls = { head: 0, list: 0 };
    const bucket = new Proxy(ctx.bucket, { get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (p === "head") return (...a: unknown[]) => { calls.head++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      // a tiny page size, so several pages are needed
      if (p === "list") return (o: R2ListOptions) => { calls.list++; return t.list({ ...o, limit: 2 }); };
      return typeof v === "function" ? v.bind(t) : v;
    } });
    await importData({ ...ctx, bucket }, { data: dump, mode: "merge" });
    expect(calls.head).toBe(0);
    expect(calls.list).toBe(3); // 5 objects, 2 per page
    const exported = (await exportData(admin())).media;
    expect(exported.map((m) => m.id).sort()).toEqual([...ids].sort());
    expect(exported.every((m) => m.size === fixtures.png.byteLength)).toBe(true);
  });

  it("自サイトの url で R2 に実体があれば fetch せずに済ます", async () => {
    await seed();
    const dump = await exportData(admin());
    const spy = vi.spyOn(globalThis, "fetch");
    await importData(admin(), { data: dump, mode: "replace", confirm: "dev-site" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("大きな取り込みは複数チャンクに分かれても全件入る（日本語・引用符を含むデータも崩れない）", async () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({
      id: `e_${String(i).padStart(12, "0")}`, collection: "memo", slug: `s-${i}`, status: "draft" as const,
      data: { body: `「${i}」'quote' "dq" \\ ${"あ".repeat(3000)}` },
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", publishedAt: null,
    }));
    const dump = emptyDump({ collections: [{ name: "memo", fields: [{ name: "body", type: "textarea" }] }], entries });
    expect(await importData(admin(), { data: dump, mode: "merge" })).toEqual({ collections: 1, entries: 120, media: 0 });
    expect((await exportData(admin())).entries).toEqual(entries);
  });

  describe("検証（何も書かない）", () => {
    const snapshot = async () => [await count("collections"), await count("entries"), await count("media"), await version()];

    it("壊れた参照があると何も書かずに validation_failed。path は entries[i].data.cover の形", async () => {
      await seed();
      const dump = await exportData(admin());
      await emptyTrash(admin(), "dev-site");
      dump.entries.push({
        id: "e_zzzzzzzzzzzz", collection: "news", slug: null, status: "draft", data: { title: "x", cover: "m_000000000000", related: "e_000000000000" },
        createdAt: dump.exportedAt, updatedAt: dump.exportedAt, publishedAt: null,
      });
      const before = await snapshot();
      const spy = mockPng();
      const paths = await issuesOf(importData(admin(), { data: dump, mode: "merge" }));
      expect(paths).toEqual([`entries[${dump.entries.length - 1}].data.cover`, `entries[${dump.entries.length - 1}].data.related`]);
      expect(await snapshot()).toEqual(before);
      expect(spy).not.toHaveBeenCalled(); // not even media fetches
    });
    it("取り込みに含まれるメディア・エントリや既存のものは参照できる。別コレクションの参照は不可", async () => {
      await seed();
      await createCollection(admin(), { name: "blog", fields: [{ name: "ref", type: "reference", collection: "news" }] });
      const dump = emptyDump({
        collections: [{ name: "blog", fields: [{ name: "ref", type: "reference", collection: "news" }] }],
        entries: [{
          id: "e_aaaaaaaaaaaa", collection: "blog", slug: null, status: "draft", data: { ref: "e_aaaaaaaaaaab" },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", publishedAt: null,
        }, {
          id: "e_aaaaaaaaaaab", collection: "blog", slug: null, status: "draft", data: {},
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", publishedAt: null,
        }],
      });
      expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["entries[0].data.ref"]); // blog entry, not news
      const existing = (await env.DB.prepare("SELECT id FROM entries WHERE slug = 'winter'").first<{ id: string }>())!.id;
      dump.entries[0].data = { ref: existing };
      await importData(admin(), { data: dump, mode: "merge" });
      // replace: everything existing goes to the trash, so a reference to it is no longer valid
      expect(await issuesOf(importData(admin(), { data: dump, mode: "replace", confirm: "dev-site" }))).toEqual(["collections[0].fields[0].collection", "entries[0].data.ref"]);
    });
    it("構造・コレクション定義・エントリ・メディアの問題をまとめて報告する", async () => {
      const dump = emptyDump({
        collections: [
          { name: "ok", fields: [{ name: "a", type: "text" }] },
          { name: "bad", fields: [{ name: "t", type: "text" }, { name: "s", type: "select" }] },
          { name: "ok", fields: [] },
        ] as never,
        entries: [
          { id: "nope", collection: "ok", slug: "Bad Slug", status: "live", data: {}, createdAt: "x", updatedAt: "y", publishedAt: null },
          { id: "e_aaaaaaaaaaaa", collection: "missing", slug: null, status: "draft", data: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", publishedAt: null },
          { id: "e_bbbbbbbbbbbb", collection: "ok", slug: null, status: "published", data: { zz: 1, a: 3 }, createdAt: "2026-01-01", updatedAt: "2026-01-01", publishedAt: null },
        ] as never,
        media: [{ id: "bad", filename: "a.png", mimeType: "image/png", size: 1, width: null, height: null, alt: "", createdAt: "2026-01-01", url: "ftp://x" }] as never,
      });
      const before = await snapshot();
      const paths = await issuesOf(importData(admin(), { data: dump, mode: "merge" }));
      expect(paths).toEqual(expect.arrayContaining([
        "collections[1].fields[1].options", "collections[2].name",
        "entries[0].id", "entries[0].slug", "entries[0].status", "entries[0].createdAt",
        "entries[1].collection", "entries[2].data.zz", "entries[2].data.a",
        "media[0].id", "media[0].url",
      ]));
      expect(await snapshot()).toEqual(before);
    });
    it("required は取り込みでは強制しない（published でも欠けていてよい）が、型は検証する", async () => {
      const col = { name: "n", fields: [{ name: "title", type: "text", required: true }] };
      const mk = (data: unknown) => emptyDump({
        collections: [col] as never,
        entries: [{ id: "e_aaaaaaaaaaaa", collection: "n", slug: null, status: "published", data, createdAt: "2026-01-01", updatedAt: "2026-01-01", publishedAt: null }] as never,
      });
      expect(await issuesOf(importData(admin(), { data: mk({ title: 1 }), mode: "merge" }))).toEqual(["entries[0].data.title"]);
      await importData(admin(), { data: mk({}), mode: "merge" });
    });
    it("format / version / 配列が無いと validation_failed", async () => {
      const paths = await issuesOf(importData(admin(), { data: { format: "x", version: 2 } as never, mode: "merge" }));
      expect(paths).toEqual(["format", "version", "collections", "entries", "media"]);
      expect(await issuesOf(importData(admin(), { data: emptyDump(), mode: "other" as never }))).toEqual(["mode"]);
      expect(await issuesOf(importData(admin(), { data: null as never, mode: "merge" }))).toEqual(["data"]);
    });
    it("別のエントリが同じ slug を使っている（ゴミ箱含む）と entries[i].slug の issue", async () => {
      const { other } = await seed();
      const dump = await exportData(admin());
      await trashEntry(admin(), "news", other.id);
      dump.entries = [{ ...dump.entries.find((e) => e.id === other.id)!, id: "e_aaaaaaaaaaaa" }];
      expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["entries[0].slug"]);
      // data 内の重複も同じ
      dump.entries = [{ ...dump.entries[0], slug: "same" }, { ...dump.entries[0], id: "e_aaaaaaaaaaab", slug: "same" }];
      expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["entries[1].slug"]);
    });
    it("single コレクションにエントリが2件以上になる取り込みは不可", async () => {
      const col = { name: "site", kind: "single", fields: [] };
      const e = (id: string) => ({ id, collection: "site", slug: null, status: "draft", data: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", publishedAt: null });
      const dump = emptyDump({ collections: [col] as never, entries: [e("e_aaaaaaaaaaaa"), e("e_aaaaaaaaaaab")] as never });
      expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["entries[1]"]);
    });
    it("メディアの取得に失敗したら D1 は何も書かない（path は media[i].url）", async () => {
      await seed();
      const dump = await exportData(admin());
      await resetSite(admin(), "dev-site");
      await emptyTrash(admin(), "dev-site");
      const m2 = { ...dump.media[0], id: "m_aaaaaaaaaaab", url: "https://example.com/missing.png" };
      dump.media.push(m2);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
        String(input).includes("missing") ? new Response("no", { status: 404 }) : new Response(fixtures.png, { headers: { "content-type": "image/png" } }));
      const before = await snapshot();
      expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["media[1].url"]);
      expect(await snapshot()).toEqual(before);
    });
    it("メディアの取得に失敗したら、この取り込みが新しく書いた R2 オブジェクトは消し、前からあったものは残す", async () => {
      await seed();
      const dump = await exportData(admin());
      const kept = await uploadMedia(admin(), { bytes: fixtures.gif, filename: "kept.gif" });
      const base = dump.media[0];
      dump.media = [
        { ...base, id: "m_aaaaaaaaaaa1", url: "https://example.com/new.png" }, // brand new id: written, then removed
        { ...base, id: kept.id, url: "https://example.com/over.png" }, // existing row + object: overwritten, kept
        { ...base, id: "m_aaaaaaaaaaa2", url: "https://example.com/missing.png" }, // fails
      ];
      dump.entries = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
        String(input).includes("missing") ? new Response("no", { status: 404 }) : new Response(fixtures.png, { headers: { "content-type": "image/png" } }));
      expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["media[2].url"]);
      const keys = (await env.MEDIA.list({ prefix: "media/" })).objects.map((o) => o.key).sort();
      expect(keys).toEqual([`media/${base.id}`, `media/${kept.id}`].sort());
    });
    it("最後の D1 の書き込みが失敗しても、新しく書いた R2 オブジェクトは消す", async () => {
      const ctx = admin();
      const db = new Proxy(ctx.db, { get(t, p) {
        if (p === "batch") return async () => { throw new Error("D1_ERROR: simulated"); };
        const v = Reflect.get(t, p) as unknown;
        return typeof v === "function" ? v.bind(t) : v;
      } });
      mockPng();
      const dump = emptyDump({ media: [{
        id: "m_aaaaaaaaaaa3", filename: "a.png", mimeType: "image/png", size: 1, width: null, height: null, alt: "",
        createdAt: "2026-01-01T00:00:00.000Z", url: "https://example.com/a.png",
      }] });
      await expect(importData({ ...ctx, db }, { data: dump, mode: "merge" })).rejects.toThrow("simulated");
      expect((await env.MEDIA.list({ prefix: "media/" })).objects).toEqual([]);
    });
    it("replace でもメディア取得に失敗したら既存はそのまま（ゴミ箱に移さない）", async () => {
      await seed();
      const dump = await exportData(admin());
      dump.media[0].url = "https://example.com/missing.png";
      await env.MEDIA.delete(`media/${dump.media[0].id}`);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("no", { status: 500 }));
      expect(await issuesOf(importData(admin(), { data: dump, mode: "replace", confirm: "dev-site" }))).toEqual(["media[0].url"]);
      expect(await listTrash(admin())).toEqual([]);
    });
    it("20MB を超えるメディアは issue", async () => {
      await seed();
      const dump = await exportData(admin());
      await env.MEDIA.delete(`media/${dump.media[0].id}`);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response("x", { headers: { "content-length": String(21 * 1024 * 1024) } }));
      expect(await issuesOf(importData(admin(), { data: dump, mode: "merge" }))).toEqual(["media[0].url"]);
    });
    it("admin 以外は不可", async () => {
      await expect(importData(reader(), { data: emptyDump(), mode: "merge" })).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});

describe("resetSite", () => {
  it("confirm が要る", async () => {
    await seed();
    await expect(resetSite(admin(), undefined)).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(resetSite(admin(), "wrong")).rejects.toMatchObject({ code: "confirmation_required" });
    expect(await listTrash(admin())).toEqual([]);
  });
  it("全部ゴミ箱へ移すだけ。listTrash の件数と一致し、restore で戻せる", async () => {
    const { media, entry } = await seed();
    const v = await version();
    expect(await resetSite(admin(), "dev-site")).toEqual({ trashed: 2 });
    expect(await version()).toBe(v + 1);
    const trash = await listTrash(admin());
    expect(trash.map((t) => t.type).sort()).toEqual(["collection", "media"]);
    expect(await exportData(admin())).toMatchObject({ collections: [], entries: [], media: [] });
    expect(await count("entries")).toBe(2); // nothing deleted
    for (const t of trash) await restoreFromTrash(admin(), t.id);
    expect((await getEntryRecord(admin(), "news", entry.id)).status).toBe("published");
    expect((await exportData(admin())).media.map((m) => m.id)).toEqual([media.id]);
  });
  it("既にゴミ箱にあるものは数えない", async () => {
    await seed();
    await createCollection(admin(), { name: "old", fields: [] });
    await trashCollection(admin(), "old");
    expect(await resetSite(admin(), "dev-site")).toEqual({ trashed: 2 });
    expect(await resetSite(admin(), "dev-site")).toEqual({ trashed: 0 });
  });
  it("admin 以外は不可", async () => {
    await expect(resetSite(reader(), "dev-site")).rejects.toMatchObject({ code: "forbidden" });
  });
});
