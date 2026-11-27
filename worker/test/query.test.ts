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
  it("accepts after / before as strings", () => {
    expect(q("after=e_abc&before=x")).toMatchObject({ after: "e_abc", before: "x" });
  });
  it("parses filter / fields / expand / limit", () => {
    expect(q("filter[category]=info&filter[price][gte]=1000&fields=title,body&expand=author&limit=5&offset=2&sort=-price&status=all"))
      .toEqual({
        filter: { category: "info", price: { gte: "1000" } }, fields: ["title", "body"], expand: ["author"],
        limit: 5, offset: 2, sort: "-price", status: "all",
      });
  });
  it("a plain value and an operator on the same field are merged into eq", () => {
    expect(q("filter[price]=1&filter[price][lt]=9").filter).toEqual({ price: { eq: "1", lt: "9" } });
  });
  it("an invalid value gives 400", () => {
    expect(() => q("limit=abc")).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => q("status=weird")).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => q("filter[a][b][c]=1")).toThrowError(expect.objectContaining({ code: "bad_request" }));
  });
});

describe("listEntryRecords", () => {
  it("by default only published entries, sorted by publishedAt descending", async () => {
    const r = await listEntryRecords(pub(), "news", {});
    expect(r.total).toBe(2);
    expect(r.items[0].publishedAt! >= r.items[1].publishedAt!).toBe(true);
  });
  it("filter and operators", async () => {
    const r = await listEntryRecords(admin(), "news", parseListParams(new URLSearchParams("filter[price][gte]=1000&status=all")));
    expect(r.items.every(e => (e.data.price as number) >= 1000)).toBe(true);
    expect(r.total).toBe(2);
  });
  it("an unknown field or an SQL fragment gives 400 and a hint with the usable names", async () => {
    await expect(listEntryRecords(admin(), "news", { filter: { "title') OR 1=1--": "x" } }))
      .rejects.toMatchObject({ code: "bad_request", hint: expect.stringContaining("title") });
    await expect(listEntryRecords(admin(), "news", { sort: "-nope" })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("limit is capped at 100", async () => {
    expect((await listEntryRecords(admin(), "news", { limit: 1000 })).limit).toBe(100);
    expect((await listEntryRecords(admin(), "news", { limit: 0 })).limit).toBe(1);
    expect((await listEntryRecords(admin(), "news", {})).limit).toBe(10);
  });
  it("public sees only published entries even with status=all", async () => {
    expect((await listEntryRecords(pub(), "news", { status: "all" })).total).toBe(2);
    expect((await listEntryRecords(reader(), "news", { status: "draft" })).total).toBe(2);
  });
  it("admin can filter by status; the default is published", async () => {
    expect((await listEntryRecords(admin(), "news", {})).total).toBe(2);
    expect(titles(await listEntryRecords(admin(), "news", { status: "draft" }))).toEqual(["Cherry"]);
    expect((await listEntryRecords(admin(), "news", { status: "all" })).total).toBe(3);
  });
  it("trashed entries are always excluded", async () => {
    await env.DB.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?").bind("now", ids[2]).run();
    expect((await listEntryRecords(admin(), "news", { status: "all" })).total).toBe(2);
  });
  it("a private collection gives not_found for public, and read can read it", async () => {
    await createCollection(admin(), { name: "secret", public: false, fields: [{ name: "title", type: "text" }] });
    const e = await createEntry(admin(), "secret", { data: { title: "s" }, status: "published" });
    await expect(listEntryRecords(pub(), "secret", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(listEntryRecords(admin(), "nope", {})).rejects.toMatchObject({ code: "not_found" });
    expect((await listEntryRecords(reader(), "secret", {})).items[0].id).toBe(e.id);
  });
  it("offset and total", async () => {
    const r = await listEntryRecords(admin(), "news", { status: "all", sort: "title", limit: 1, offset: 1 });
    expect(titles(r)).toEqual(["Banana 100%"]);
    expect(r).toMatchObject({ total: 3, limit: 1, offset: 1 });
  });
  it("sort with multiple keys, and null comes last", async () => {
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "-price" }))).toEqual(["Cherry", "Banana 100%", "Apple"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "-when" }))).toEqual(["Banana 100%", "Apple", "Cherry"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "when" }))).toEqual(["Apple", "Banana 100%", "Cherry"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "category,-title" }))).toEqual(["Banana 100%", "Cherry", "Apple"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", sort: "-publishedAt,title" }))[2]).toBe("Cherry");
  });
  it("filter and sort by built-in fields (slug, createdAt)", async () => {
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", filter: { slug: "b" } }))).toEqual(["Banana 100%"]);
    expect(titles(await listEntryRecords(admin(), "news", { status: "all", filter: { slug: { in: "a,c" } }, sort: "-slug" }))).toEqual(["Cherry", "Apple"]);
    const future = await listEntryRecords(admin(), "news", { status: "all", filter: { createdAt: { gt: "2999-01-01" } } });
    expect(future.total).toBe(0);
  });
  it("type conversion for eq / ne / in / lt", async () => {
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
  it("contains: text uses LIKE (% is treated as a character), multi-select matches an element", async () => {
    const run = (filter: Record<string, string | Record<string, string>>) =>
      listEntryRecords(admin(), "news", { status: "all", sort: "title", filter }).then(titles);
    expect(await run({ title: { contains: "an" } })).toEqual(["Banana 100%"]);
    expect(await run({ title: { contains: "%" } })).toEqual(["Banana 100%"]);
    expect(await run({ title: { contains: "_" } })).toEqual([]);
    expect(await run({ tags: { contains: "a" } })).toEqual(["Apple"]);
    expect(await run({ tags: { contains: "c" } })).toEqual(["Banana 100%"]);
  });
  it("a value or operator that does not fit the type, and list/json fields, give 400", async () => {
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
  it("values are not interpreted as SQL", async () => {
    const r = await listEntryRecords(admin(), "news", { status: "all", filter: { title: "x' OR '1'='1" } });
    expect(r.total).toBe(0);
    const r2 = await listEntryRecords(admin(), "news", { status: "all", filter: { title: { in: "a') OR 1=1 --,b" } } });
    expect(r2.total).toBe(0);
  });
  it("an in over the bind limit gives 400", async () => {
    const many = Array.from({ length: 51 }, (_, i) => i).join(",");
    await expect(listEntryRecords(admin(), "news", { filter: { price: { in: many } } })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("an unpublished draft disappears from the public list", async () => {
    await unpublishEntry(admin(), "news", ids[0]);
    expect((await listEntryRecords(pub(), "news", {})).total).toBe(1);
  });
});

describe("after / before (from the next / previous entry)", () => {
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
    it(`for any sort order, after returns the next one and before returns the previous one (${sort || "default"})`, async () => {
      await seed();
      const all = await order(sort);
      expect(all.length).toBe(7);
      for (let i = 0; i < all.length; i++) {
        expect(await order(`${sort}&after=${all[i]}&limit=1`)).toEqual(all.slice(i + 1, i + 2));
        expect(await order(`${sort}&before=${all[i]}&limit=1`)).toEqual(all.slice(Math.max(0, i - 1), i));
      }
    });
  }

  it("limit, offset and total count within the range beyond the cursor; before is also returned in the same direction as the list", async () => {
    await seed();
    const all = await order("");
    const after = await listEntryRecords(admin(), "posts", q(`status=all&after=${all[1]}&limit=2&offset=1`));
    expect(after.items.map(e => e.id)).toEqual(all.slice(3, 5));
    expect(after.total).toBe(5);
    const before = await listEntryRecords(admin(), "posts", q(`status=all&before=${all[5]}&limit=3`));
    expect(before.items.map(e => e.id)).toEqual(all.slice(2, 5));
    expect(before.total).toBe(5);
  });

  it("can also be given by slug, and a draft cannot be used as a cursor by someone who sees only published entries", async () => {
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
