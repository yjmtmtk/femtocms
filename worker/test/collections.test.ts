import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCtx, getSetting, requireConfirm } from "../src/core/context";
import { createCollection, getCollection, listCollections, updateCollection } from "../src/core/collections";

const admin = () => createCtx(env, "https://cms.test", "admin");
const pub = () => createCtx(env, "https://cms.test", "public");
const news = { name: "news", label: "お知らせ", kind: "list", fields: [
  { name: "title", type: "text", required: true, maxLength: 100 },
  { name: "body", type: "markdown" },
  { name: "category", type: "select", options: ["info", "event"] } ] };

it("can be created and fetched", async () => {
  const c = await createCollection(admin(), news);
  expect(c.id).toMatch(/^c_[0-9a-z]{12}$/);
  expect(c.public).toBe(true);
  expect((await getCollection(admin(), "news")).fields).toHaveLength(3);
});
it("a reserved name gives validation_failed", async () => {
  await expect(createCollection(admin(), { ...news, name: "media" })).rejects.toMatchObject({ code: "validation_failed" });
});
it("select without options puts a path in issues", async () => {
  const bad = { ...news, fields: [{ name: "category", type: "select" }] };
  await expect(createCollection(admin(), bad)).rejects.toMatchObject({
    code: "validation_failed", issues: [expect.objectContaining({ path: "fields[0].options" })] });
});
it("the same name gives conflict", async () => {
  await createCollection(admin(), news);
  await expect(createCollection(admin(), news)).rejects.toMatchObject({ code: "conflict" });
});
it("the public role cannot create", async () => {
  await expect(createCollection(pub(), news)).rejects.toMatchObject({ code: "unauthorized" });
});
it("the public role can get a public collection; a private one gives not_found", async () => {
  await createCollection(admin(), news);
  await createCollection(admin(), { ...news, name: "secret", public: false });
  await expect(getCollection(pub(), "news")).resolves.toBeTruthy();
  await expect(getCollection(pub(), "secret")).rejects.toMatchObject({ code: "not_found" });
});
it("a write raises content_version", async () => {
  const before = Number(await getSetting(admin(), "content_version") ?? 0);
  await createCollection(admin(), news);
  expect(Number(await getSetting(admin(), "content_version"))).toBe(before + 1);
});

describe("additional validation", () => {
  const bad = async (fields: unknown[], path?: string) => {
    const p = expect(createCollection(admin(), { name: "x", fields })).rejects;
    await p.toMatchObject({ code: "validation_failed" });
    if (path) await p.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path })]) });
  };
  it("duplicate field name", () => bad([{ name: "a", type: "text" }, { name: "a", type: "text" }], "fields[1].name"));
  it("reserved field names id/slug/status", async () => {
    for (const n of ["id", "slug", "status"]) await bad([{ name: n, type: "text" }], "fields[0].name");
  });
  it("reference requires collection", () => bad([{ name: "r", type: "reference" }], "fields[0].collection"));
  it("list requires fields", () => bad([{ name: "l", type: "list" }], "fields[0].fields"));
  it("a list cannot be nested inside a list", () =>
    bad([{ name: "l", type: "list", fields: [{ name: "m", type: "list", fields: [{ name: "t", type: "text" }] }] }], "fields[0].fields[0].type"));
  it("invalid collection name", async () => {
    await expect(createCollection(admin(), { name: "Bad_Name", fields: [] })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("list, update and trash", () => {
  it("listCollections needs read or higher; public sees only public collections", async () => {
    await createCollection(admin(), news);
    await createCollection(admin(), { ...news, name: "secret", public: false });
    expect((await listCollections(admin())).map((c) => c.name).sort()).toEqual(["news", "secret"]);
    expect((await listCollections(pub())).map((c) => c.name)).toEqual(["news"]);
  });
  it("the same name as a trashed collection gives conflict with a hint; get gives not_found", async () => {
    const c = await createCollection(admin(), news);
    await env.DB.prepare("UPDATE collections SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), c.id).run();
    await expect(getCollection(admin(), "news")).rejects.toMatchObject({ code: "not_found" });
    expect(await listCollections(admin())).toEqual([]);
    await expect(createCollection(admin(), news)).rejects.toMatchObject({
      code: "conflict", hint: expect.stringContaining("restore_from_trash") });
  });
  it("updateCollection can update fields and label; name cannot be changed", async () => {
    await createCollection(admin(), news);
    const u = await updateCollection(admin(), "news", { label: "ニュース", fields: [{ name: "title", type: "text" }] });
    expect(u.label).toBe("ニュース");
    expect(u.fields).toHaveLength(1);
    await expect(updateCollection(admin(), "news", { name: "other" })).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("changing to single gives conflict when 2 or more active entries exist", async () => {
    const c = await createCollection(admin(), news);
    const ins = (id: string) => env.DB.prepare(
      "INSERT INTO entries (id, collection_id, status, data, created_at, updated_at) VALUES (?, ?, 'draft', '{}', 'x', 'x')").bind(id, c.id).run();
    await ins("e_aaaaaaaaaaaa"); await ins("e_bbbbbbbbbbbb");
    await expect(updateCollection(admin(), "news", { kind: "single" })).rejects.toMatchObject({ code: "conflict" });
  });
  it("a reference to a missing collection gives validation_failed", async () => {
    await createCollection(admin(), news);
    await expect(updateCollection(admin(), "news", { fields: [{ name: "r", type: "reference", collection: "nope" }] }))
      .rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("basics", () => {
  it("the read role cannot create and gets forbidden (403)", async () => {
    const ctx = createCtx(env, "https://cms.test", "read");
    await expect(createCollection(ctx, news)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(listCollections(ctx)).resolves.toEqual([]);
  });
  it("requireConfirm gives confirmation_required without the site name", () => {
    expect(() => requireConfirm(admin(), undefined)).toThrow(expect.objectContaining({
      code: "confirmation_required", hint: expect.stringContaining(`"${env.SITE_NAME}"`) }));
    expect(() => requireConfirm(admin(), env.SITE_NAME)).not.toThrow();
  });
});

describe("default must pass the field's own validation (path is fields[i].default)", () => {
  const issuesOf = async (fields: unknown[]) => {
    const e = await createCollection(admin(), { name: "d", fields }).then(() => null, (x) => x);
    expect(e).toMatchObject({ code: "validation_failed" });
    return (e as { issues: { path: string }[] }).issues.map((i) => i.path);
  };

  it("a default that does not fit the type, options, length or range is rejected on create", async () => {
    expect(await issuesOf([
      { name: "title", type: "text", maxLength: 3, default: "toolong" },
      { name: "n", type: "number", min: 0, default: -1 },
      { name: "kind", type: "select", options: ["a", "b"], default: "c" },
      { name: "tags", type: "select", options: ["a"], multiple: true, default: ["a", "z"] },
      { name: "on", type: "boolean", default: "yes" },
      { name: "at", type: "datetime", default: "someday" },
      { name: "pic", type: "image", default: "not-an-id" },
    ])).toEqual([
      "fields[0].default", "fields[1].default", "fields[2].default", "fields[3].default[1]",
      "fields[4].default", "fields[5].default", "fields[6].default",
    ]);
  });

  it("defaults of fields inside a list, and the default of the list itself, are also validated", async () => {
    expect(await issuesOf([{ name: "rows", type: "list", default: [{ q: 1 }], fields: [
      { name: "q", type: "text" }, { name: "n", type: "number", default: "x" },
    ] }])).toEqual(["fields[0].fields[1].default", "fields[0].default[0].q"]);
  });

  it("a valid default passes and is also validated on update", async () => {
    await createCollection(admin(), { name: "ok", fields: [
      { name: "kind", type: "select", options: ["a", "b"], default: "a" }, { name: "at", type: "datetime", default: "2026-01-01T00:00:00Z" },
      { name: "extra", type: "json", default: { any: ["thing"] } },
    ] });
    await expect(updateCollection(admin(), "ok", { fields: [{ name: "kind", type: "select", options: ["a"], default: "b" }] }))
      .rejects.toMatchObject({ code: "validation_failed", issues: [expect.objectContaining({ path: "fields[0].default" })] });
  });
});
