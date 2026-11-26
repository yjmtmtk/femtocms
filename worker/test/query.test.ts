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
