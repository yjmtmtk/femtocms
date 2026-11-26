import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCtx } from "../src/core/context";
import { createCollection } from "../src/core/collections";
import { createEntry, listEntryRecords, publishEntry, unpublishEntry } from "../src/core/entries";
import { parseListParams } from "../src/core/query";

const admin = () => createCtx(env, "https://cms.test", "admin");
const pub = () => createCtx(env, "https://cms.test", "public");
const reader = () => createCtx(env, "https://cms.test", "read");
const q = (s: string) => parseListParams(new URLSearchParams(s));
const titles = (r: { items: { data: Record<string, unknown> }[] }) => r.items.map(e => e.data.title);

const news = { name: "news", kind: "list", fields: [
  { name: "title", type: "text", required: true },
  { name: "category", type: "select", options: ["info", "event"] },
  { name: "tags", type: "select", options: ["a", "b", "c"], multiple: true },
  { name: "price", type: "number" },
  { name: "featured", type: "boolean" },
  { name: "when", type: "datetime" },
  { name: "items", type: "list", fields: [{ name: "x", type: "text" }] },
  { name: "extra", type: "json" } ] };

let ids: string[] = [];

beforeEach(async () => {
  await createCollection(admin(), news);
  const a = await createEntry(admin(), "news", { slug: "a", data: { title: "Apple", category: "info", price: 500, tags: ["a", "b"], featured: true, when: "2026-01-01T00:00:00Z" } });
  const b = await createEntry(admin(), "news", { slug: "b", data: { title: "Banana 100%", category: "event", price: 1000, tags: ["c"], featured: false, when: "2026-02-01T00:00:00Z" } });
  const c = await createEntry(admin(), "news", { slug: "c", data: { title: "Cherry", category: "info", price: 2000 } });
  ids = [a.id, b.id, c.id];
  await publishEntry(admin(), "news", a.id);
  await publishEntry(admin(), "news", b.id);
});

describe("parseListParams", () => {
  it("after / before を文字列で受け取る", () => {
    expect(q("after=e_abc&before=x")).toMatchObject({ after: "e_abc", before: "x" });
  });
  it("filter / fields / expand / limit を解釈する", () => {
    expect(q("filter[category]=info&filter[price][gte]=1000&fields=title,body&expand=author&limit=5&offset=2&sort=-price&status=all"))
      .toEqual({
        filter: { category: "info", price: { gte: "1000" } }, fields: ["title", "body"], expand: ["author"],
        limit: 5, offset: 2, sort: "-price", status: "all",
      });
  });
  it("同じフィールドの素の値と演算子を併記すると eq にまとめる", () => {
    expect(q("filter[price]=1&filter[price][lt]=9").filter).toEqual({ price: { eq: "1", lt: "9" } });
  });
  it("不正な値は 400", () => {
    expect(() => q("limit=abc")).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => q("status=weird")).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => q("filter[a][b][c]=1")).toThrowError(expect.objectContaining({ code: "bad_request" }));
  });
});

describe("listEntryRecords", () => {
  it("既定は公開済みのみ・publishedAt 降順", async () => {
    const r = await listEntryRecords(pub(), "news", {});
    expect(r.total).toBe(2);
    expect(r.items[0].publishedAt! >= r.items[1].publishedAt!).toBe(true);
  });
  it("filter と演算子", async () => {
    const r = await listEntryRecords(admin(), "news", parseListParams(new URLSearchParams("filter[price][gte]=1000&status=all")));
    expect(r.items.every(e => (e.data.price as number) >= 1000)).toBe(true);
    expect(r.total).toBe(2);
  });
  it("未知のフィールドや SQL 断片は 400 と使える名前の hint", async () => {
    await expect(listEntryRecords(admin(), "news", { filter: { "title') OR 1=1--": "x" } }))
      .rejects.toMatchObject({ code: "bad_request", hint: expect.stringContaining("title") });
    await expect(listEntryRecords(admin(), "news", { sort: "-nope" })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("limit は最大 100 に丸める", async () => {
    expect((await listEntryRecords(admin(), "news", { limit: 1000 })).limit).toBe(100);
    expect((await listEntryRecords(admin(), "news", { limit: 0 })).limit).toBe(1);
    expect((await listEntryRecords(admin(), "news", {})).limit).toBe(10);
  });
  it("public は status=all を指定しても公開済みだけ", async () => {
    expect((await listEntryRecords(pub(), "news", { status: "all" })).total).toBe(2);
    expect((await listEntryRecords(reader(), "news", { status: "draft" })).total).toBe(2);
  });
  it("admin は status で絞れる。既定は published", async () => {
    expect((await listEntryRecords(admin(), "news", {})).total).toBe(2);
    expect(titles(await listEntryRecords(admin(), "news", { status: "draft" }))).toEqual(["Cherry"]);
    expect((await listEntryRecords(admin(), "news", { status: "all" })).total).toBe(3);
  });
  it("ゴミ箱のエントリは常に除外する", async () => {
    await env.DB.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?").bind("now", ids[2]).run();
    expect((await listEntryRecords(admin(), "news", { status: "all" })).total).toBe(2);
  });
  it("public の非公開コレクションは not_found、read は読める", async () => {
    await createCollection(admin(), { name: "secret", public: false, fields: [{ name: "title", type: "text" }] });
    const e = await createEntry(admin(), "secret", { data: { title: "s" }, status: "published" });
    await expect(listEntryRecords(pub(), "secret", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(listEntryRecords(admin(), "nope", {})).rejects.toMatchObject({ code: "not_found" });
    expect((await listEntryRecords(reader(), "secret", {})).items[0].id).toBe(e.id);
  });
  it("offset と total", async () => {
    const r = await listEntryRecords(admin(), "news", { status: "all", sort: "title", limit: 1, offset: 1 });
    expect(titles(r)).toEqual(["Banana 100%"]);
    expect(r).toMatchObject({ total: 3, limit: 1, offset: 1 });
  });
  it("複数キーの sort と null は最後", async () => {
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "-price" }))).toEqual(["Cherry", "Banana 100%", "Apple"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "-when" }))).toEqual(["Banana 100%", "Apple", "Cherry"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "when" }))).toEqual(["Apple", "Banana 100%", "Cherry"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "category,-title" }))).toEqual(["Banana 100%", "Cherry", "Apple"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "-publishedAt,title" }))[2]).toBe("Cherry");
  });
  it("組み込みフィールド (slug, createdAt) で絞り込み・並べ替え", async () => {
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", filter: { slug: "b" } }))).toEqual(["Banana 100%"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", filter: { slug: { in: "a,c" } }, sort: "-slug" }))).toEqual(["Cherry", "Apple"]);
    const future = await listEntryRecords(admin(), "news", { status: "all", filter: { createdAt: { gt: "2999-01-01" } } });
    expect(future.total).toBe(0);
  });
  it("eq / ne / in / lt の型変換", async () => {
    const run = (filter: Record<string, string | Record<string, string>>) =>
      listEntryRecords(admin(), "news", { status: "all", sort: "title", filter }).then(titles);
    expect(await run({ price: "1000" })).toEqual(["Banana 100%"]);
    expect(await run({ price: { lt: "1000" } })).toEqual(["Apple"]);
    expect(await run({ price: { in: "500,2000" } })).toEqual(["Apple", "Cherry"]);
    expect(await run({ featured: "true" })).toEqual(["Apple"]);
    expect(await run({ featured: "false" })).toEqual(["Banana 100%"]);
    expect(await run({ featured: { ne: "true" } })).toEqual(["Banana 100%", "Cherry"]); // ne keeps nulls
    expect(await run({ category: { ne: "info" } })).toEqual(["Banana 100%"]);
    expect(await run({ when: { gte: "2026-01-15" } })).toEqual(["Banana 100%"]);
    expect(await run({ category: "info", price: { gt: "500" } })).toEqual(["Cherry"]);
  });
  it("contains: text は LIKE（% は文字として扱う）、複数選択は要素一致", async () => {
    const run = (filter: Record<string, string | Record<string, string>>) =>
      listEntryRecords(admin(), "news", { status: "all", sort: "title", filter }).then(titles);
    expect(await run({ title: { contains: "an" } })).toEqual(["Banana 100%"]);
    expect(await run({ title: { contains: "%" } })).toEqual(["Banana 100%"]);
    expect(await run({ title: { contains: "_" } })).toEqual([]);
    expect(await run({ tags: { contains: "a" } })).toEqual(["Apple"]);
    expect(await run({ tags: { contains: "c" } })).toEqual(["Banana 100%"]);
  });
  it("型に合わない値・演算子・list/json は 400", async () => {
    const bad = (filter: Record<string, string | Record<string, string>>) =>
      expect(listEntryRecords(admin(), "news", { filter })).rejects.toMatchObject({ code: "bad_request" });
    await bad({ price: "abc" });
    await bad({ featured: "yes" });
    await bad({ when: "not a date" });
    await bad({ price: { contains: "1" } });
    await bad({ featured: { gt: "1" } });
    await bad({ tags: "a" });
    await bad({ title: { regex: "x" } });
    await bad({ items: "x" });
    await bad({ extra: "x" });
    await expect(listEntryRecords(admin(), "news", { sort: "tags" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(listEntryRecords(admin(), "news", { sort: "items" })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("値は SQL として解釈されない", async () => {
    const r = await listEntryRecords(admin(), "news", { status: "all", filter: { title: "x' OR '1'='1" } });
    expect(r.total).toBe(0);
    const r2 = await listEntryRecords(admin(), "news", { status: "all", filter: { title: { in: "a') OR 1=1 --,b" } } });
    expect(r2.total).toBe(0);
  });
  it("バインド上限を超える in は 400", async () => {
    const many = Array.from({ length: 51 }, (_, i) => i).join(",");
    await expect(listEntryRecords(admin(), "news", { filter: { price: { in: many } } })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("unpublish した下書きは public 一覧から消える", async () => {
    await unpublishEntry(admin(), "news", ids[0]);
    expect((await listEntryRecords(pub(), "news", {})).total).toBe(1);
  });
});

describe("after / before（この記事の次・前から）", () => {
  // Ties on purpose: four entries share one publish time, and two of those also share a created time.
  const T = "2026-05-01T00:00:00.000Z";
  async function seed(): Promise<string[]> {
    await createCollection(admin(), { name: "posts", kind: "list", fields: [{ name: "title", type: "text" }, { name: "rank", type: "number" }] });
    const spec: [string, string | null, string, number | null][] = [
      ["p1", "2026-06-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 3],
      ["p2", T, "2026-01-02T00:00:00.000Z", 1],
      ["p3", T, "2026-01-03T00:00:00.000Z", null],
      ["p4", T, "2026-01-03T00:00:00.000Z", 2],
      ["p5", T, "2026-01-04T00:00:00.000Z", 1],
      ["p6", "2026-04-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z", null],
      ["p7", null, "2026-01-06T00:00:00.000Z", 5],
    ];
    const out: string[] = [];
    for (const [slug, pub, created, rank] of spec) {
      const e = await createEntry(admin(), "posts", { slug, data: rank === null ? { title: slug } : { title: slug, rank } });
      if (pub) await publishEntry(admin(), "posts", e.id);
      await env.DB.prepare("UPDATE entries SET published_at = ?, created_at = ? WHERE id = ?").bind(pub, created, e.id).run();
      out.push(e.id);
    }
    return out;
  }
  const order = async (s: string) => (await listEntryRecords(admin(), "posts", q(`limit=100&status=all${s}`))).items.map(e => e.id);

  for (const sort of ["", "&sort=-publishedAt", "&sort=rank", "&sort=-rank,title", "&sort=publishedAt"]) {
    it(`どの並び順でも、after は1つ後ろ、before は1つ前を返す（${sort || "既定"}）`, async () => {
      await seed();
      const all = await order(sort);
      expect(all.length).toBe(7);
      for (let i = 0; i < all.length; i++) {
        expect(await order(`${sort}&after=${all[i]}&limit=1`)).toEqual(all.slice(i + 1, i + 2));
        expect(await order(`${sort}&before=${all[i]}&limit=1`)).toEqual(all.slice(Math.max(0, i - 1), i));
      }
    });
  }

  it("limit・offset・total は、カーソルの先の範囲で数える。before も一覧と同じ向きで返す", async () => {
    await seed();
    const all = await order("");
    const after = await listEntryRecords(admin(), "posts", q(`status=all&after=${all[1]}&limit=2&offset=1`));
    expect(after.items.map(e => e.id)).toEqual(all.slice(3, 5));
    expect(after.total).toBe(5);
    const before = await listEntryRecords(admin(), "posts", q(`status=all&before=${all[5]}&limit=3`));
    expect(before.items.map(e => e.id)).toEqual(all.slice(2, 5));
    expect(before.total).toBe(5);
  });

  it("slug でも指定でき、公開済みだけを見る人には下書きをカーソルに使わせない", async () => {
    const ids = await seed();
    const pubAll = (await listEntryRecords(pub(), "posts", q("limit=100"))).items.map(e => e.id);
    expect(pubAll).not.toContain(ids[6]);
    expect((await listEntryRecords(pub(), "posts", q("after=p2&limit=1"))).items.map(e => e.id))
      .toEqual(pubAll.slice(pubAll.indexOf(ids[1]) + 1, pubAll.indexOf(ids[1]) + 2));
    await expect(listEntryRecords(pub(), "posts", q("after=p7"))).rejects.toMatchObject({ code: "bad_request" });
    await expect(listEntryRecords(admin(), "posts", q("after=nope"))).rejects.toMatchObject({ code: "bad_request" });
    await expect(listEntryRecords(admin(), "posts", q("after=p1&before=p2"))).rejects.toMatchObject({ code: "bad_request" });
  });
});
