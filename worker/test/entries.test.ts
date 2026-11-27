import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCtx, getSetting } from "../src/core/context";
import { createCollection, updateCollection } from "../src/core/collections";
import {
  createEntry, getEntryRecord, getSingle, publishEntry, putSingle, unpublishEntry, updateEntry,
} from "../src/core/entries";

const admin = () => createCtx(env, "https://cms.test", "admin");
const pub = () => createCtx(env, "https://cms.test", "public");
const reader = () => createCtx(env, "https://cms.test", "read");
const news = { name: "news", label: "お知らせ", kind: "list", fields: [
  { name: "title", type: "text", required: true, maxLength: 100 },
  { name: "body", type: "markdown" },
  { name: "category", type: "select", options: ["info", "event"] } ] };

beforeEach(async () => {
  await createCollection(admin(), news);
  await createCollection(admin(), { name: "site", kind: "single", fields: [{ name: "catch", type: "text" }] });
});

const insertMedia = (id: string, deleted = false) =>
  env.DB.prepare("INSERT INTO media (id, filename, mime_type, size, created_at, deleted_at) VALUES (?, 'a.png', 'image/png', 1, 'now', ?)")
    .bind(id, deleted ? "now" : null).run();

it("creating a draft and publishing it sets publishedAt", async () => {
  const e = await createEntry(admin(), "news", { data: { body: "下書き" } });
  expect(e.status).toBe("draft");
  await expect(publishEntry(admin(), "news", e.id)).rejects.toMatchObject({
    code: "validation_failed", issues: [expect.objectContaining({ path: "data.title" })] });
  await updateEntry(admin(), "news", e.id, { data: { title: "冬" } });
  const p = await publishEntry(admin(), "news", e.id);
  expect(p.status).toBe("published");
  expect(p.publishedAt).not.toBeNull();
  expect(p.data).toEqual({ title: "冬", body: "下書き" });
});
it("can also be fetched by slug, and public cannot see drafts", async () => {
  const e = await createEntry(admin(), "news", { data: { title: "a" }, slug: "winter" });
  expect((await getEntryRecord(admin(), "news", "winter")).id).toBe(e.id);
  await expect(getEntryRecord(pub(), "news", "winter")).rejects.toMatchObject({ code: "not_found" });
});
it("the same slug gives 409", async () => {
  await createEntry(admin(), "news", { data: { title: "a" }, slug: "dup" });
  await expect(createEntry(admin(), "news", { data: { title: "b" }, slug: "dup" })).rejects.toMatchObject({ code: "conflict" });
});
it("a missing image id gives validation_failed", async () => {
  await updateCollection(admin(), "news", { fields: [...news.fields, { name: "cover", type: "image" }] });
  await expect(createEntry(admin(), "news", { data: { title: "a", cover: "m_000000000000" } }))
    .rejects.toMatchObject({ code: "validation_failed", issues: [expect.objectContaining({ path: "data.cover" })] });
});
it("single: put creates or replaces, and a second create gives conflict", async () => {
  await putSingle(admin(), "site", { data: { catch: "やあ" } });
  await putSingle(admin(), "site", { data: { catch: "こんにちは" } });
  expect((await getSingle(admin(), "site")).data).toEqual({ catch: "こんにちは" });
  await expect(createEntry(admin(), "site", { data: {} })).rejects.toMatchObject({ code: "conflict" });
});

describe("write permission and versions", () => {
  it("only admin can write", async () => {
    await expect(createEntry(pub(), "news", { data: {} })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(createEntry(reader(), "news", { data: {} })).rejects.toMatchObject({ code: "forbidden" });
    const e = await createEntry(admin(), "news", { data: {} });
    await expect(updateEntry(reader(), "news", e.id, { data: {} })).rejects.toMatchObject({ code: "forbidden" });
    await expect(publishEntry(reader(), "news", e.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(unpublishEntry(reader(), "news", e.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(putSingle(reader(), "site", { data: {} })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("each write raises content_version", async () => {
    const v = async () => Number(await getSetting(admin(), "content_version"));
    const v0 = await v();
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    expect(await v()).toBe(v0 + 1);
    await updateEntry(admin(), "news", e.id, { data: { body: "b" } });
    await publishEntry(admin(), "news", e.id);
    await unpublishEntry(admin(), "news", e.id);
    expect(await v()).toBe(v0 + 4);
    await putSingle(admin(), "site", { data: { catch: "x" } });
    expect(await v()).toBe(v0 + 5);
  });
});

describe("read visibility", () => {
  it("published entries can be read by public/read, and public gets not_found unless the collection is public", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" }, status: "published" });
    expect((await getEntryRecord(pub(), "news", e.id)).id).toBe(e.id);
    await createCollection(admin(), { name: "secret", public: false, fields: [{ name: "t", type: "text" }] });
    const s = await createEntry(admin(), "secret", { data: { t: "x" }, status: "published" });
    await expect(getEntryRecord(pub(), "secret", s.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await getEntryRecord(reader(), "secret", s.id)).id).toBe(s.id);
  });
  it("even the read role cannot see drafts, unless allowDraft is set", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await expect(getEntryRecord(reader(), "news", e.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await getEntryRecord(pub(), "news", e.id, { allowDraft: true })).id).toBe(e.id);
  });
  it("a trashed entry gives not_found even for admin", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await env.DB.prepare("UPDATE entries SET deleted_at = 'now' WHERE id = ?").bind(e.id).run();
    await expect(getEntryRecord(admin(), "news", e.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("a missing id or slug gives not_found", async () => {
    await expect(getEntryRecord(admin(), "news", "e_000000000000")).rejects.toMatchObject({ code: "not_found" });
    await expect(getEntryRecord(admin(), "news", "nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("getSingle gives not_found when the single entry is not created, and public cannot see it before it is published", async () => {
    await expect(getSingle(admin(), "site")).rejects.toMatchObject({ code: "not_found" });
    await putSingle(admin(), "site", { data: { catch: "x" } });
    await expect(getSingle(pub(), "site")).rejects.toMatchObject({ code: "not_found" });
    await putSingle(admin(), "site", { data: { catch: "x" }, status: "published" });
    expect((await getSingle(pub(), "site")).status).toBe("published");
  });
});

describe("validation", () => {
  it("types are validated even for drafts, and required applies only on publish", async () => {
    await expect(createEntry(admin(), "news", { data: { title: 1 } })).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "data.title" })] });
    await expect(createEntry(admin(), "news", { data: {}, status: "published" })).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "data.title", message: "required" })] });
  });
  it("an invalid slug gives validation_failed", async () => {
    await expect(createEntry(admin(), "news", { data: {}, slug: "Bad_Slug" })).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "slug" })] });
  });
  it("references: trashed media, an entry of another collection and the position inside a list become issues", async () => {
    await insertMedia("m_aaaaaaaaaaaa");
    await insertMedia("m_bbbbbbbbbbbb", true);
    await createCollection(admin(), { name: "authors", fields: [{ name: "n", type: "text" }] });
    await createCollection(admin(), { name: "posts", fields: [
      { name: "cover", type: "image" },
      { name: "related", type: "list", fields: [{ name: "a", type: "reference", collection: "authors" }] },
      { name: "author", type: "reference", collection: "authors" } ] });
    const au = await createEntry(admin(), "authors", { data: { n: "x" } });
    const nw = await createEntry(admin(), "news", { data: { title: "t" } });
    const ok = await createEntry(admin(), "posts", { data: { cover: "m_aaaaaaaaaaaa", author: au.id } });
    expect(ok.data).toEqual({ cover: "m_aaaaaaaaaaaa", author: au.id });
    await expect(createEntry(admin(), "posts", { data: {
      cover: "m_bbbbbbbbbbbb",
      related: [{ a: au.id }, { a: nw.id }, { a: "e_000000000000" }],
    } })).rejects.toMatchObject({ code: "validation_failed", issues: [
      expect.objectContaining({ path: "data.cover" }),
      expect.objectContaining({ path: "data.related[1].a" }),
      expect.objectContaining({ path: "data.related[2].a" }) ] });
    await env.DB.prepare("UPDATE entries SET deleted_at = 'now' WHERE id = ?").bind(au.id).run();
    await expect(createEntry(admin(), "posts", { data: { author: au.id } })).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "data.author" })] });
  });
  it("image multiple: a missing id becomes an issue at data.gallery[i]", async () => {
  await insertMedia("m_aaaaaaaaaaaa");
  await createCollection(admin(), { name: "albums", fields: [{ name: "gallery", type: "image", multiple: true }] });
  const ok = await createEntry(admin(), "albums", { data: { gallery: ["m_aaaaaaaaaaaa", { id: "m_aaaaaaaaaaaa" }] } });
  expect(ok.data).toEqual({ gallery: ["m_aaaaaaaaaaaa", "m_aaaaaaaaaaaa"] });
  await expect(createEntry(admin(), "albums", { data: { gallery: ["m_aaaaaaaaaaaa", "m_000000000000"] } })).rejects.toMatchObject({
    code: "validation_failed", issues: [expect.objectContaining({ path: "data.gallery[1]" })] });
});
it("a missing collection gives not_found", async () => {
    await expect(createEntry(admin(), "nope", { data: {} })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("updateEntry (R1, R8)", () => {
  it("merges at the top level, and null removes the field", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a", body: "b" } });
    const u = await updateEntry(admin(), "news", e.id, { data: { body: null, category: "info" } });
    expect(u.data).toEqual({ title: "a", category: "info" });
  });
  it("an unknown field in the patch gives validation_failed", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await expect(updateEntry(admin(), "news", e.id, { data: { nope: 1 } })).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "data.nope" })] });
  });
  it("stored values of fields removed from the schema remain and do not break on update", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a", body: "old" } });
    await updateCollection(admin(), "news", { fields: [{ name: "title", type: "text", required: true }] });
    const u = await updateEntry(admin(), "news", e.id, { data: { title: "b" } });
    expect(u.data).toEqual({ title: "b", body: "old" });
    const raw = await env.DB.prepare("SELECT data FROM entries WHERE id = ?").bind(e.id).first<{ data: string }>();
    expect(JSON.parse(raw!.data)).toEqual({ title: "b", body: "old" });
  });
  it("for a published entry, required is enforced on update too", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" }, status: "published" });
    await expect(updateEntry(admin(), "news", e.id, { data: { title: null } })).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "data.title" })] });
  });
  it("slug and publishedAt can be updated, and a slug clash gives conflict", async () => {
    await createEntry(admin(), "news", { data: { title: "a" }, slug: "one" });
    const e = await createEntry(admin(), "news", { data: { title: "b" }, slug: "two" });
    const u = await updateEntry(admin(), "news", "two", { slug: null, publishedAt: "2026-01-02T03:04:05Z" });
    expect(u.slug).toBeNull();
    expect(u.publishedAt).toBe("2026-01-02T03:04:05.000Z");
    await expect(updateEntry(admin(), "news", e.id, { slug: "one" })).rejects.toMatchObject({ code: "conflict" });
    await expect(updateEntry(admin(), "news", e.id, { publishedAt: "yesterday" })).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "publishedAt" })] });
  });
  it("the default of a field that is not in the patch does not overwrite the stored value", async () => {
    await updateCollection(admin(), "news", { fields: [
      { name: "title", type: "text" }, { name: "category", type: "select", options: ["info", "event"], default: "info" }] });
    const e = await createEntry(admin(), "news", { data: { title: "a", category: "event" } });
    expect((await updateEntry(admin(), "news", e.id, { data: { title: "b" } })).data).toEqual({ title: "b", category: "event" });
  });
});

it("patch validation on update does not apply defaults (it does not fail on the existence check of the default of an image that is not in the patch)", async () => {
  await insertMedia("m_aaaaaaaaaaaa");
  await updateCollection(admin(), "news", { fields: [...news.fields, { name: "cover", type: "image", default: "m_000000000000" }] });
  const e = await createEntry(admin(), "news", { data: { title: "a", cover: "m_aaaaaaaaaaaa" } });
  const u = await updateEntry(admin(), "news", e.id, { data: { title: "b" } });
  expect(u.data).toEqual({ title: "b", cover: "m_aaaaaaaaaaaa" });
});

describe("default is applied only on create (R8)", () => {
  const withDefault = () => updateCollection(admin(), "news", { fields: [
    { name: "title", type: "text" }, { name: "category", type: "select", options: ["info", "event"], default: "info" }] });
  it("on create the default is applied, and after being cleared with null it does not come back on unrelated updates", async () => {
    await withDefault();
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    expect(e.data).toEqual({ title: "a", category: "info" });
    expect((await updateEntry(admin(), "news", e.id, { data: { category: null } })).data).toEqual({ title: "a" });
    expect((await updateEntry(admin(), "news", e.id, { data: { title: "x" } })).data).toEqual({ title: "x" });
  });
  it("does not come back on publish either", async () => {
    await withDefault();
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await updateEntry(admin(), "news", e.id, { data: { category: null } });
    expect((await publishEntry(admin(), "news", e.id)).data).toEqual({ title: "a" });
  });
  it("putSingle: the default is applied on a new create, but not when replacing an existing entry", async () => {
    await updateCollection(admin(), "site", { fields: [
      { name: "catch", type: "text" }, { name: "lang", type: "text", default: "ja" }] });
    expect((await putSingle(admin(), "site", { data: { catch: "a" } })).data).toEqual({ catch: "a", lang: "ja" });
    expect((await putSingle(admin(), "site", { data: { catch: "b" } })).data).toEqual({ catch: "b" });
  });
});

describe("publish / unpublish", () => {
  it("unpublish keeps publishedAt, and republishing does not change it", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const p = await publishEntry(admin(), "news", e.id);
    const d = await unpublishEntry(admin(), "news", e.id);
    expect(d.status).toBe("draft");
    expect(d.publishedAt).toBe(p.publishedAt);
    await expect(getEntryRecord(pub(), "news", e.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await publishEntry(admin(), "news", e.id)).publishedAt).toBe(p.publishedAt);
  });
  it("create with published sets publishedAt, and an explicit value can be used", async () => {
    const a = await createEntry(admin(), "news", { data: { title: "a" }, status: "published" });
    expect(a.publishedAt).not.toBeNull();
    const b = await createEntry(admin(), "news", { data: { title: "b" }, status: "published", publishedAt: "2020-05-06T00:00:00Z" });
    expect(b.publishedAt).toBe("2020-05-06T00:00:00.000Z");
  });
  it("on publish, a stored reference that no longer exists gives validation_failed", async () => {
    await insertMedia("m_aaaaaaaaaaaa");
    await updateCollection(admin(), "news", { fields: [...news.fields, { name: "cover", type: "image" }] });
    const e = await createEntry(admin(), "news", { data: { title: "a", cover: "m_aaaaaaaaaaaa" } });
    await env.DB.prepare("UPDATE media SET deleted_at = 'now'").run();
    await expect(publishEntry(admin(), "news", e.id)).rejects.toMatchObject({
      code: "validation_failed", issues: [expect.objectContaining({ path: "data.cover" })] });
  });
});

describe("single", () => {
  it("put keeps non-schema keys of the stored entry, and the conflict has a hint", async () => {
    await putSingle(admin(), "site", { data: { catch: "a" } });
    await env.DB.prepare("UPDATE entries SET data = ?").bind(JSON.stringify({ catch: "a", legacy: 1 })).run();
    await putSingle(admin(), "site", { data: { catch: "b" } });
    const raw = await env.DB.prepare("SELECT data FROM entries").first<{ data: string }>();
    expect(JSON.parse(raw!.data)).toEqual({ catch: "b", legacy: 1 });
    await expect(createEntry(admin(), "site", { data: {} })).rejects.toMatchObject({
      code: "conflict", hint: expect.stringContaining("PUT /api/<name>") });
  });
  it("put keeps status and can publish when it is given; it cannot be used on a list collection", async () => {
    const a = await putSingle(admin(), "site", { data: { catch: "a" }, status: "published" });
    expect(a.publishedAt).not.toBeNull();
    expect((await putSingle(admin(), "site", { data: { catch: "b" } })).status).toBe("published");
    await expect(putSingle(admin(), "news", { data: {} })).rejects.toMatchObject({ code: "bad_request" });
    await expect(getSingle(admin(), "news")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("number of queries for reference existence checks (D1 query limit)", () => {
  /** A ctx whose D1 records every prepared SQL. */
  function spied() {
    const ctx = admin();
    const prepared: string[] = [];
    const spy = { ...ctx, db: new Proxy(ctx.db, { get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (p === "prepare") return (sql: string) => { prepared.push(sql); return t.prepare(sql); };
      return typeof v === "function" ? v.bind(t) : v;
    } }) } as typeof ctx;
    return { ctx: spy, prepared };
  }
  const id = (prefix: string, i: number) => `${prefix}_${String(i).padStart(12, "0")}`;

  beforeEach(async () => {
    await createCollection(admin(), { name: "albums", fields: [
      { name: "photos", type: "image", multiple: true },
      { name: "related", type: "reference", collection: "news", multiple: true },
    ] });
    await env.DB.batch(Array.from({ length: 60 }, (_, i) => env.DB.prepare(
      "INSERT INTO media (id, filename, mime_type, size, created_at) VALUES (?, 'a.png', 'image/png', 1, 'now')").bind(id("m", i))));
    const c = await env.DB.prepare("SELECT id FROM collections WHERE name = 'news'").first<{ id: string }>();
    await env.DB.batch(Array.from({ length: 60 }, (_, i) => env.DB.prepare(
      "INSERT INTO entries (id, collection_id, status, data, created_at, updated_at) VALUES (?, ?, 'draft', '{}', 'now', 'now')").bind(id("e", i), c!.id)));
  });

  it("creating an entry with 60 images and 60 references still needs only 1 media query and 1 entries query for the existence check", async () => {
    const { ctx, prepared } = spied();
    const photos = Array.from({ length: 60 }, (_, i) => id("m", i));
    const related = Array.from({ length: 60 }, (_, i) => id("e", i));
    const e = await createEntry(ctx, "albums", { data: { photos, related } });
    expect(e.data.photos).toHaveLength(60);
    expect(prepared.filter((s) => /FROM media/i.test(s))).toHaveLength(1);
    expect(prepared.filter((s) => /FROM entries e JOIN collections/i.test(s))).toHaveLength(1);
    expect(prepared.length).toBeLessThanOrEqual(8);
  });

  it("even when checked in bulk, missing, trashed and other-collection references are each reported at their own path", async () => {
    await env.DB.prepare("UPDATE media SET deleted_at = 'now' WHERE id = ?").bind(id("m", 1)).run();
    await env.DB.prepare("UPDATE entries SET deleted_at = 'now' WHERE id = ?").bind(id("e", 1)).run();
    const other = await createEntry(admin(), "albums", { data: {} });
    const { ctx, prepared } = spied();
    const err = await createEntry(ctx, "albums", { data: {
      photos: [id("m", 0), id("m", 1), "m_zzzzzzzzzzzz"], related: [id("e", 0), id("e", 1), other.id, "e_zzzzzzzzzzzz"],
    } }).then(() => null, (x) => x);
    expect(err).toMatchObject({ code: "validation_failed" });
    expect((err as { issues: { path: string; message: string }[] }).issues.map((i) => [i.path, i.message])).toEqual([
      ["data.photos[1]", "media not found (missing or in trash)"],
      ["data.photos[2]", "media not found (missing or in trash)"],
      ["data.related[1]", "referenced entry not found (missing or in trash)"],
      ["data.related[2]", 'referenced entry belongs to "albums"'],
      ["data.related[3]", "referenced entry not found (missing or in trash)"],
    ]);
    expect(prepared.filter((s) => /FROM media/i.test(s))).toHaveLength(1);
  });
});
