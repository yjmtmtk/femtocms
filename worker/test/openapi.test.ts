import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapSql } from "../src/core/key-format";
import { buildOpenApi, fieldToJsonSchema } from "../src/core/openapi";
import type { Collection, FieldDef } from "../src/core/types";
import { VERSION } from "../src/version";

const K = "fcms_admin_" + "a".repeat(32);
const NOW = "2026-11-26T00:00:00.000Z";

const fields: FieldDef[] = [
  { name: "title", type: "text", required: true, maxLength: 100, description: "Headline" },
  { name: "category", type: "select", options: ["info", "event"] },
  { name: "tags", type: "select", options: ["a", "b"], multiple: true },
  { name: "body", type: "markdown" },
  { name: "rating", type: "number", integer: true, min: 1, max: 5 },
  { name: "featured", type: "boolean" },
  { name: "when", type: "datetime" },
  { name: "cover", type: "image" },
  { name: "gallery", type: "image", multiple: true },
  { name: "author", type: "reference", collection: "blog-post" },
  { name: "related", type: "reference", collection: "blog-post", multiple: true },
  { name: "blocks", type: "list", fields: [{ name: "heading", type: "text" }, { name: "pic", type: "image" }] },
  { name: "extra", type: "json" },
];
const collection = (name: string, kind: "list" | "single", pub: boolean, f: FieldDef[] = fields): Collection => ({
  id: `c_${name}`, name, label: null, description: null, kind, public: pub, fields: f, createdAt: NOW, updatedAt: NOW,
});
const newsCollection = collection("news", "list", true);
const all = [newsCollection, collection("site", "single", true, [{ name: "title", type: "text" }]), collection("blog-post", "list", false)];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
const build = (cols = all): Doc => buildOpenApi(cols, "https://cms.test", "my-site");

describe("fieldToJsonSchema", () => {
  const f = (name: string) => fields.find((x) => x.name === name)!;
  it("write: schema per field type", () => {
    expect(fieldToJsonSchema(f("title"), "write")).toEqual({ type: "string", maxLength: 100, description: "Headline" });
    expect(fieldToJsonSchema(f("category"), "write")).toEqual({ type: "string", enum: ["info", "event"] });
    expect(fieldToJsonSchema(f("tags"), "write")).toEqual({ type: "array", items: { type: "string", enum: ["a", "b"] } });
    expect(fieldToJsonSchema(f("body"), "write")).toMatchObject({ type: "string" });
    expect(fieldToJsonSchema(f("rating"), "write")).toEqual({ type: "integer", minimum: 1, maximum: 5 });
    expect(fieldToJsonSchema(f("featured"), "write")).toEqual({ type: "boolean" });
    expect(fieldToJsonSchema(f("when"), "write")).toEqual({ type: "string", format: "date-time" });
    expect(fieldToJsonSchema(f("cover"), "write")).toMatchObject({ type: "string", pattern: "^m_[0-9a-z]{12}$" });
    expect(fieldToJsonSchema(f("gallery"), "write")).toMatchObject({ type: "array", items: { type: "string", pattern: "^m_[0-9a-z]{12}$" } });
    expect(fieldToJsonSchema(f("author"), "write")).toMatchObject({ type: "string", pattern: "^e_[0-9a-z]{12}$" });
    expect(fieldToJsonSchema(f("related"), "write")).toMatchObject({ type: "array", items: { type: "string", pattern: "^e_[0-9a-z]{12}$" } });
    expect(fieldToJsonSchema(f("extra"), "write")).not.toHaveProperty("type");
    const list = fieldToJsonSchema(f("blocks"), "write") as Doc;
    expect(list.type).toBe("array");
    expect(list.items.properties.heading).toEqual({ type: "string" });
    expect(list.items.properties.pic.pattern).toBe("^m_[0-9a-z]{12}$");
  });
  it("read: image is ApiMedia, reference is an id string (null if the target is missing, dropped when multiple), markdown is a string", () => {
    expect(fieldToJsonSchema(f("cover"), "read")).toEqual({ anyOf: [{ $ref: "#/components/schemas/ApiMedia" }, { type: "null" }] });
    expect(fieldToJsonSchema(f("gallery"), "read")).toEqual({ type: "array", items: { $ref: "#/components/schemas/ApiMedia" } });
    expect(fieldToJsonSchema(f("author"), "read")).toMatchObject({ type: ["string", "null"], pattern: "^e_[0-9a-z]{12}$" });
    expect(fieldToJsonSchema(f("author"), "read").description).toMatch(/null/);
    expect(fieldToJsonSchema(f("related"), "read")).toMatchObject({ type: "array", items: { type: "string", pattern: "^e_[0-9a-z]{12}$" } });
    expect(fieldToJsonSchema(f("body"), "read")).toMatchObject({ type: "string" });
  });
  it("default appears only in write", () => {
    const d: FieldDef = { name: "n", type: "number", default: 3 };
    expect(fieldToJsonSchema(d, "write")).toMatchObject({ default: 3 });
    expect(fieldToJsonSchema(d, "read")).not.toHaveProperty("default");
  });
});

describe("buildOpenApi", () => {
  it("collection fields appear in the create requestBody", () => {
    const doc = build([newsCollection]);
    expect(doc.openapi).toBe("3.1.0");
    const body = doc.paths["/api/news"].post.requestBody.content["application/json"].schema;
    const data = doc.components.schemas[body.properties.data.$ref.split("/").pop()];
    expect(data.properties.title).toMatchObject({ type: "string", maxLength: 100 });
    expect(data.properties.category).toMatchObject({ enum: ["info", "event"] });
    expect(data.additionalProperties).toBe(false);
  });

  it("required is not listed in required; the description says it applies only on publish", () => {
    const write = build().components.schemas.NewsDataWrite;
    expect(write.required).toBeUndefined();
    expect(write.description).toMatch(/title/);
    expect(write.description).toMatch(/published/);
  });

  it("info / servers / security", () => {
    const doc = build();
    expect(doc.info.title).toBe("femtocms — my-site");
    expect(doc.info.version).toBe(VERSION);
    expect(doc.servers).toEqual([{ url: "https://cms.test" }]);
    for (const word of ["fcms_admin_", "fcms_read_", "trash", "confirm", "validation_failed", "issues", "hint"]) {
      expect(doc.info.description).toContain(word);
    }
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
  });

  it("list collections get list/get/create/update/delete/publish/unpublish; single collections get get/put", () => {
    const doc = build();
    expect(Object.keys(doc.paths["/api/news"])).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths["/api/news/{id}"])).toEqual(["get", "patch", "delete"]);
    expect(doc.paths["/api/news/{id}/publish"].post).toBeDefined();
    expect(doc.paths["/api/news/{id}/unpublish"].post).toBeDefined();
    expect(Object.keys(doc.paths["/api/site"])).toEqual(["get", "put"]);
    expect(doc.paths["/api/site/{id}"]).toBeUndefined();
    expect(doc.paths["/api/site/{id}/publish"].post).toBeDefined();
  });

  it("common paths are included", () => {
    const doc = build([]);
    for (const p of ["/api/collections", "/api/collections/{name}", "/api/media", "/api/media/{id}", "/api/trash", "/api/trash/{id}",
      "/api/trash/{id}/restore", "/api/keys", "/api/keys/{id}", "/api/export", "/api/import", "/api/reset"]) {
      expect(doc.paths[p], p).toBeDefined();
    }
  });

  it("query parameters of the list endpoint", () => {
    const names = build().paths["/api/news"].get.parameters.map((p: Doc) => p.name);
    expect(names).toEqual(["limit", "offset", "sort", "filter[field]", "filter[field][op]", "fields", "expand", "status", "after", "before"]);
    const status = build().paths["/api/news"].get.parameters.find((p: Doc) => p.name === "status");
    expect(status.schema.default).toBe("published");
    expect(status.description).toMatch(/Admin only/);
  });

  it("read schema: html only for markdown fields, image is ApiMedia", () => {
    const s = build().components.schemas;
    expect(Object.keys(s.NewsEntry.properties.html.properties)).toEqual(["body"]);
    expect(s.NewsData.properties.cover.anyOf[0]).toEqual({ $ref: "#/components/schemas/ApiMedia" });
    expect(s.NewsData.properties.author.type).toEqual(["string", "null"]);
  });

  it("a name with hyphens becomes a valid component name", () => {
    const s = build().components.schemas;
    expect(s.BlogPostEntry).toBeDefined();
    expect(s.BlogPostData).toBeDefined();
    expect(s.BlogPostDataWrite).toBeDefined();
    for (const name of Object.keys(s)) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("colliding names still become separate components", () => {
    const a = collection("a--b", "list", true, []);
    const b = collection("a-b", "list", true, []);
    const s = build([a, b]).components.schemas;
    const entryNames = Object.keys(s).filter((k) => k.endsWith("Entry"));
    expect(entryNames).toHaveLength(2);
  });

  it("structure: every $ref resolves, every operation has responses, and path parameters are declared", () => {
    const doc = build();
    const refs: string[] = [];
    JSON.stringify(doc, (_k, v) => { if (v && typeof v === "object" && typeof v.$ref === "string") refs.push(v.$ref); return v; });
    expect(refs.length).toBeGreaterThan(10);
    for (const r of refs) {
      expect(r).toMatch(/^#\/components\/schemas\//);
      expect(doc.components.schemas[r.replace("#/components/schemas/", "")], r).toBeDefined();
    }
    const methods = ["get", "put", "post", "delete", "patch"];
    for (const [path, item] of Object.entries<Doc>(doc.paths)) {
      expect(Object.keys(item).every((k) => methods.includes(k)), path).toBe(true);
      const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries<Doc>(item)) {
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
        expect(typeof op.summary).toBe("string");
        const declared = (op.parameters ?? []).filter((p: Doc) => p.in === "path").map((p: Doc) => p.name);
        expect(declared.sort(), `${method} ${path}`).toEqual([...templated].sort());
        for (const code of Object.keys(op.responses)) expect(code).toMatch(/^[1-5]\d\d$/);
      }
    }
  });
});

describe("GET /api/openapi.json", () => {
  const get = (key?: string) => SELF.fetch("https://cms.test/api/openapi.json", { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  const post = (path: string, body: unknown) =>
    SELF.fetch(`https://cms.test${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

  beforeEach(async () => {
    await env.DB.exec(await bootstrapSql(K, "test", NOW));
    expect((await post("/api/collections", { name: "news", fields: [{ name: "title", type: "text", maxLength: 100 }] })).status).toBe(201);
    expect((await post("/api/collections", { name: "secret", public: false, fields: [{ name: "note", type: "text" }] })).status).toBe(201);
  });

  it("public does not list private collections and gets public cache headers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const doc: Doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("femtocms — dev-site");
    expect(doc.servers).toEqual([{ url: "https://cms.test" }]);
    expect(doc.paths["/api/news"]).toBeDefined();
    expect(doc.paths["/api/secret"]).toBeUndefined();
    expect(doc.components.schemas.SecretEntry).toBeUndefined();
  });

  it("admin / read keys list all collections and get no-store", async () => {
    const created: Doc = await (await post("/api/keys", { name: "r", role: "read" })).json();
    for (const key of [K, created.key as string]) {
      const res = await get(key);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const doc: Doc = await res.json();
      expect(doc.paths["/api/secret"]).toBeDefined();
      expect(doc.paths["/api/news"].get).toBeDefined();
    }
  });

  it("/api/openapi.json is resolved before /api/:c (not treated as a collection)", async () => {
    const res = await get(K);
    expect((await res.json() as Doc).openapi).toBe("3.1.0");
  });
});
