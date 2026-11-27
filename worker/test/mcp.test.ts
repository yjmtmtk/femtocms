import { SELF, env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as collectionsModule from "../src/core/collections";
import { createCtx } from "../src/core/context";
import { bootstrapSql } from "../src/core/key-format";
import { createKey } from "../src/core/keys";
import { fixtures } from "./fixtures/images";

const K = "fcms_admin_" + "a".repeat(32);
const NOW = "2026-11-26T00:00:00.000Z";
const SITE = "dev-site";

const news = {
  name: "news",
  fields: [{ name: "title", type: "text", required: true, description: "見出し" }, { name: "body", type: "markdown" }],
};
const site = { name: "site", kind: "single", fields: [{ name: "title", type: "text" }] };

const clients: Client[] = [];
async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://cms.test/mcp"), {
    fetch: (input, init) => SELF.fetch(input as string, init),
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = any;
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as Out;
const errorOf = (r: Out) => JSON.parse(r.content[0].text).error;

const post = (key: string | undefined, body: unknown = {}) =>
  SELF.fetch("https://cms.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await env.DB.exec(await bootstrapSql(K, "test", NOW));
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  vi.restoreAllMocks();
});

describe("authentication", () => {
  it("no key gives 401 (WWW-Authenticate: Bearer)", async () => {
    const res = await SELF.fetch("https://cms.test/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await res.json() as Out).error.code).toBe("unauthorized");
  });
  it("an invalid key also gives 401", async () => {
    const res = await post("fcms_admin_" + "z".repeat(32));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });
  it("a read key gives 403 (no tools are shown)", async () => {
    const { key } = await createKey(createCtx(env, "https://cms.test", "admin"), { name: "reader", role: "read" });
    const res = await post(key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect((await res.json() as Out).error.code).toBe("forbidden");
  });
  it("GET / DELETE give 405 (stateless, so there is no SSE and no session end)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await SELF.fetch("https://cms.test/mcp", {
        method, headers: { Authorization: `Bearer ${K}`, Accept: "text/event-stream" },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
    // Unauthenticated callers learn nothing about the method handling.
    expect((await SELF.fetch("https://cms.test/mcp")).status).toBe(401);
  });
});

describe("tool list", () => {
  it("all tools exist, destructive ones have destructiveHint, and the site name is in the description", async () => {
    const client = await connect(K);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([
      "create_collection", "create_entry", "create_key", "delete_collection", "delete_entry", "delete_media",
      "delete_permanently", "empty_trash", "export_data", "get_collection", "get_entry", "get_preview_url",
      "import_data", "list_collections", "list_entries", "list_keys", "list_media", "list_trash", "publish_entry",
      "reset_site", "restore_from_trash", "revoke_key", "unpublish_entry", "update_collection", "update_entry",
      "update_media", "upload_media",
    ]);
    const tool = (n: string) => tools.find((t) => t.name === n)!;
    for (const n of ["empty_trash", "delete_permanently", "reset_site", "import_data", "delete_entry", "delete_collection", "delete_media", "revoke_key"]) {
      expect(tool(n).annotations?.destructiveHint, n).toBe(true);
    }
    for (const n of ["create_collection", "update_collection", "create_entry", "update_entry", "publish_entry", "unpublish_entry", "upload_media", "update_media", "get_preview_url", "restore_from_trash", "create_key"]) {
      expect(tool(n).annotations?.destructiveHint, n).toBe(false);
    }
    for (const n of ["list_collections", "get_collection", "list_entries", "get_entry", "list_media", "list_trash", "list_keys", "export_data"]) {
      expect(tool(n).annotations?.readOnlyHint, n).toBe(true);
    }
    for (const n of ["empty_trash", "delete_permanently", "reset_site", "import_data"]) {
      expect(tool(n).description, n).toContain(`Set confirm to the site name: "${SITE}"`);
    }
    for (const n of ["delete_entry", "delete_collection", "delete_media"]) {
      expect(tool(n).description, n).toContain("This moves the item to the trash. It can be restored with restore_from_trash.");
    }
    expect(tool("create_entry").description).toContain(
      'Before calling, call get_collection to see the fields and their descriptions. Entries are created as drafts unless status is "published". Required fields are only enforced when publishing.',
    );
    expect(tool("list_entries").description).toMatch(/default.*"published"/s);
    expect(tool("list_entries").description).toContain('"all" or "draft"');
  });

  it("every parameter has a description, and the server has instructions", async () => {
    const client = await connect(K);
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [p, schema] of Object.entries(props)) expect(schema.description, `${t.name}.${p}`).toBeTruthy();
      expect(t.description, t.name).toBeTruthy();
    }
    const instructions = client.getInstructions()!;
    expect(instructions).toMatch(/publishedAt,title.*data-fields/s);
    const desc = (tool: string, p?: string) => {
      const t = tools.find((x) => x.name === tool)!;
      return p ? ((t.inputSchema.properties as Record<string, { description: string }>)[p]!.description) : t.description!;
    };
    // read keys: published entries of every collection (non-public included), never drafts
    for (const d of [desc("create_key"), desc("create_key", "role")]) {
      expect(d).toMatch(/published entries of any collection/);
      expect(d).not.toMatch(/read drafts/);
    }
    expect(desc("upload_media", "mimeType")).toMatch(/base64 uploads only/);
    expect(instructions).toContain("list_collections");
    expect(instructions).toContain("get_preview_url");
    expect(instructions).toContain(`confirm = "${SITE}"`);
  });
});

describe("flow", () => {
  it("typical AI flow: create collection → create entry → preview → publish → list", async () => {
    const client = await connect(K);
    expect((await call(client, "create_collection", news)).structuredContent).toMatchObject({ name: "news" });
    const created = await call(client, "create_entry", { collection: "news", data: { title: "冬" } });
    expect(created.structuredContent).toMatchObject({ status: "draft" });
    const id = created.structuredContent.id;

    const hidden = await call(client, "list_entries", { collection: "news" });
    expect(hidden.structuredContent.total).toBe(0);
    expect((await call(client, "list_entries", { collection: "news", status: "draft" })).structuredContent.total).toBe(1);
    await call(client, "create_entry", { collection: "news", data: { title: "春" } });
    const ids = (r: { structuredContent: { items: { id: string }[] } }) => r.structuredContent.items.map((e) => e.id);
    const all = ids(await call(client, "list_entries", { collection: "news", status: "draft" }));
    expect(ids(await call(client, "list_entries", { collection: "news", status: "draft", after: all[0] }))).toEqual([all[1]]);
    expect(ids(await call(client, "list_entries", { collection: "news", status: "draft", before: all[1] }))).toEqual([all[0]]);

    const preview = await call(client, "get_preview_url", { collection: "news", id });
    expect(preview.structuredContent.url).toMatch(/^https:\/\/cms\.test\/preview\//);

    await call(client, "publish_entry", { collection: "news", id });
    const list = await call(client, "list_entries", { collection: "news" });
    expect(list.structuredContent.total).toBe(1);
    expect(JSON.parse(list.content[0].text)).toEqual(list.structuredContent);
    expect((await call(client, "unpublish_entry", { collection: "news", id })).structuredContent.status).toBe("draft");
  });

  it("a validation error is isError and issues can be read", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    const r = await call(client, "create_entry", { collection: "news", data: { titel: "x" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("data.titel");
    expect(errorOf(r)).toMatchObject({ code: "validation_failed", issues: [expect.objectContaining({ path: "data.titel" })] });
  });

  it("not_found and confirmation_required are isError with a hint", async () => {
    const client = await connect(K);
    expect(errorOf(await call(client, "get_collection", { name: "nope" }))).toMatchObject({ code: "not_found" });
    const r = await call(client, "empty_trash", { confirm: "wrong" });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ code: "confirmation_required", hint: expect.stringContaining(SITE) });
  });

  it("an unexpected exception has code internal and does not leak details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(collectionsModule, "listCollections").mockRejectedValue(new Error("secret db password"));
    const client = await connect(K);
    const r = await call(client, "list_collections");
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toEqual({ code: "internal", message: "Internal error" });
    expect(r.content[0].text).not.toContain("secret");
    expect(spy).toHaveBeenCalled();
  });

  it("input that does not match the schema is isError (the tool is not run)", async () => {
    const client = await connect(K);
    const r = await call(client, "list_entries", { collection: "news", status: "bogus" });
    expect(r.isError).toBe(true);
  });

  it("single collection: create_entry acts as putSingle, and get_entry works without an id", async () => {
    const client = await connect(K);
    await call(client, "create_collection", site);
    const first = await call(client, "create_entry", { collection: "site", data: { title: "a" } });
    expect(first.structuredContent).toMatchObject({ data: { title: "a" }, status: "draft" });
    const second = await call(client, "create_entry", { collection: "site", data: { title: "b" }, status: "published" });
    expect(second.isError).toBeUndefined();
    expect(second.structuredContent).toMatchObject({ id: first.structuredContent.id, data: { title: "b" }, status: "published" });
    const got = await call(client, "get_entry", { collection: "site" });
    expect(got.structuredContent).toMatchObject({ id: first.structuredContent.id, data: { title: "b" } });
    expect((await call(client, "list_entries", { collection: "site" })).structuredContent.id).toBe(first.structuredContent.id);
  });

  it("create_entry accepts publishedAt (same as HTTP POST)", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    const r = await call(client, "create_entry", { collection: "news", data: { title: "t" }, status: "published", publishedAt: "2026-01-02T03:04:05Z" });
    expect(r.structuredContent.publishedAt).toBe("2026-01-02T03:04:05.000Z");
    const bad = await call(client, "create_entry", { collection: "news", data: { title: "t" }, publishedAt: "yesterday" });
    expect(errorOf(bad).issues[0].path).toBe("publishedAt");
  });

  it("get_entry without an id on a list collection gives bad_request", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    expect(errorOf(await call(client, "get_entry", { collection: "news" }))).toMatchObject({ code: "bad_request" });
  });

  it("update_entry merges data, and delete_entry sends the entry to the trash, from where restore_from_trash brings it back", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    const { id } = (await call(client, "create_entry", { collection: "news", data: { title: "a", body: "x" } })).structuredContent;
    const updated = await call(client, "update_entry", { collection: "news", id, data: { title: "b" }, slug: "bee" });
    expect(updated.structuredContent).toMatchObject({ slug: "bee", data: { title: "b", body: "x" } });
    expect((await call(client, "delete_entry", { collection: "news", id })).structuredContent).toEqual({ deleted: true, id });
    expect(errorOf(await call(client, "get_entry", { collection: "news", id }))).toMatchObject({ code: "not_found" });
    const trash = await call(client, "list_trash");
    expect(trash.structuredContent.items).toMatchObject([{ id, type: "entry" }]);
    await call(client, "restore_from_trash", { id });
    expect((await call(client, "get_entry", { collection: "news", id })).structuredContent.slug).toBe("bee");
  });

  it("permanent delete from the trash, emptying the trash and reset need confirm", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    const { id } = (await call(client, "create_entry", { collection: "news", data: { title: "a" } })).structuredContent;
    await call(client, "delete_entry", { collection: "news", id });
    expect((await call(client, "delete_permanently", { id, confirm: "x" })).isError).toBe(true);
    expect((await call(client, "delete_permanently", { id, confirm: SITE })).structuredContent).toEqual({ deleted: true, id });
    expect((await call(client, "empty_trash", { confirm: SITE })).structuredContent).toEqual({ deleted: 0 });
    expect((await call(client, "reset_site", { confirm: "x" })).isError).toBe(true);
    expect((await call(client, "reset_site", { confirm: SITE })).structuredContent).toMatchObject({ trashed: expect.any(Number) });
  });

  it("update_collection / delete_collection / list_collections", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    expect((await call(client, "update_collection", { name: "news", patch: { label: "お知らせ" } })).structuredContent)
      .toMatchObject({ name: "news", label: "お知らせ" });
    expect((await call(client, "list_collections")).structuredContent.items).toMatchObject([{ name: "news" }]);
    expect((await call(client, "get_collection", { name: "news" })).structuredContent.fields[0]).toMatchObject({ description: "見出し" });
    expect((await call(client, "delete_collection", { name: "news" })).structuredContent).toEqual({ deleted: true, name: "news" });
    expect((await call(client, "list_collections")).structuredContent.items).toEqual([]);
  });

  it("keys: create (the plain key is shown only once), list and revoke; the last admin key cannot be revoked", async () => {
    const client = await connect(K);
    const created = (await call(client, "create_key", { name: "web", role: "read" })).structuredContent;
    expect(created.key).toMatch(/^fcms_read_/);
    const listed = (await call(client, "list_keys")).structuredContent.items;
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect((await call(client, "revoke_key", { id: created.info.id })).structuredContent).toMatchObject({ id: created.info.id });
    const admin = listed.find((k: Out) => k.role === "admin");
    expect((await call(client, "revoke_key", { id: admin.id })).isError).toBe(true);
  });

  it("export_data and import_data (merge / replace need confirm)", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    await call(client, "create_entry", { collection: "news", data: { title: "冬" }, slug: "winter", status: "published" });
    const exported = await call(client, "export_data");
    expect(exported.structuredContent.collections).toHaveLength(1);
    await call(client, "reset_site", { confirm: SITE });
    expect((await call(client, "import_data", { data: exported.structuredContent, mode: "replace" })).isError).toBe(true);
    const merged = await call(client, "import_data", { data: exported.structuredContent, mode: "merge" });
    expect(merged.structuredContent).toEqual({ collections: 1, entries: 1, media: 0 });
    expect((await call(client, "import_data", { data: exported.structuredContent, mode: "replace", confirm: SITE })).isError).toBeUndefined();
    expect((await call(client, "list_entries", { collection: "news" })).structuredContent.total).toBe(1);
  });
});

describe("media", () => {
  it("can be uploaded as base64, listed and deleted", async () => {
    const client = await connect(K);
    const base64 = btoa(String.fromCharCode(...fixtures.png));
    const m = (await call(client, "upload_media", { base64, filename: "p.png", alt: "x" })).structuredContent;
    expect(m).toMatchObject({ filename: "p.png", alt: "x", width: 1, url: expect.stringContaining("https://cms.test/media/") });
    expect((await call(client, "list_media")).structuredContent).toMatchObject({ total: 1, items: [{ id: m.id }] });
    expect((await call(client, "delete_media", { id: m.id })).structuredContent).toEqual({ deleted: true, id: m.id });
    expect((await call(client, "list_media")).structuredContent.total).toBe(0);
  });

  it("update_media can change alt (same as HTTP PATCH /api/media/:id)", async () => {
    const client = await connect(K);
    const m = (await call(client, "upload_media", { base64: btoa(String.fromCharCode(...fixtures.png)), filename: "p.png" })).structuredContent;
    const r = await call(client, "update_media", { id: m.id, alt: "新しい説明" });
    expect(r.structuredContent).toMatchObject({ id: m.id, alt: "新しい説明", url: m.url });
    expect((await call(client, "list_media")).structuredContent.items[0].alt).toBe("新しい説明");
    expect(errorOf(await call(client, "update_media", { id: "m_000000000000", alt: "x" })).code).toBe("not_found");
  });

  it("upload_media and list_media do not fail even with a filename containing an unpaired surrogate", async () => {
    const client = await connect(K);
    const r = await call(client, "upload_media", { base64: btoa(String.fromCharCode(...fixtures.png)), filename: "\ud800.png" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.url).toMatch(/\/%EF%BF%BD\.png$/);
    const list = await call(client, "list_media");
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent.items[0].filename).toBe("\ufffd.png");
  });

  it("can be imported from a url (the external fetch is mocked)", async () => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      String(input).startsWith("https://img.test/")
        ? new Response(fixtures.png, { headers: { "Content-Type": "image/png" } })
        : real(input, init));
    const client = await connect(K);
    const r = await call(client, "upload_media", { url: "https://img.test/a/pic.png" });
    expect(r.structuredContent).toMatchObject({ filename: "pic.png", mimeType: "image/png" });
  });

  it("both url and base64, neither, or base64 without filename give bad_request", async () => {
    const client = await connect(K);
    for (const args of [{}, { url: "https://img.test/a.png", base64: "AA==", filename: "a.png" }, { base64: "AA==" }]) {
      const r = await call(client, "upload_media", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(errorOf(r).code).toBe("bad_request");
    }
  });

  it("a media id can be put into an image field and read back", async () => {
    const client = await connect(K);
    await call(client, "create_collection", { name: "pages", fields: [{ name: "hero", type: "image" }] });
    const m = (await call(client, "upload_media", { base64: btoa(String.fromCharCode(...fixtures.png)), filename: "h.png" })).structuredContent;
    const e = await call(client, "create_entry", { collection: "pages", data: { hero: m.id } });
    expect(e.structuredContent.data.hero).toMatchObject({ id: m.id, url: m.url });
  });
});

describe("preview URL", () => {
  it("ttlSeconds must be an integer from 1 to 2592000 (same validation as HTTP)", async () => {
    const client = await connect(K);
    await call(client, "create_collection", news);
    const { id } = (await call(client, "create_entry", { collection: "news", data: { title: "a" } })).structuredContent;
    for (const ttlSeconds of [0, 2_592_001, 1.5, -1]) {
      const r = await call(client, "get_preview_url", { collection: "news", id, ttlSeconds });
      expect(r.isError, String(ttlSeconds)).toBe(true);
      expect(errorOf(r)).toMatchObject({ code: "validation_failed", issues: [expect.objectContaining({ path: "ttlSeconds" })] });
    }
    const ok = await call(client, "get_preview_url", { collection: "news", id, ttlSeconds: 60 });
    const secs = (Date.parse(ok.structuredContent.expiresAt) - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(55);
    expect(secs).toBeLessThanOrEqual(60);
  });
});

describe("parity with HTTP", () => {
  const http = (path: string) =>
    SELF.fetch(`https://cms.test${path}`, { headers: { Authorization: `Bearer ${K}` } }).then((r) => r.json() as Promise<Out>);

  it("the same entry fetched through the API and get_entry matches exactly (including data and html)", async () => {
    const client = await connect(K);
    await call(client, "create_collection", {
      name: "posts",
      fields: [{ name: "title", type: "text" }, { name: "body", type: "markdown" }, { name: "cover", type: "image" }],
    });
    const m = (await call(client, "upload_media", { base64: btoa(String.fromCharCode(...fixtures.png)), filename: "c.png", alt: "表紙" })).structuredContent;
    const { id } = (await call(client, "create_entry", {
      collection: "posts", slug: "hello", status: "published", data: { title: "やあ", body: "**太字** <script>x</script>", cover: m.id },
    })).structuredContent;
    const viaMcp = (await call(client, "get_entry", { collection: "posts", id })).structuredContent;
    const viaHttp = await http(`/api/posts/${id}`);
    expect(viaHttp.html.body).toContain("<strong>太字</strong>");
    expect(viaMcp).toEqual(viaHttp);
    expect((await call(client, "get_entry", { collection: "posts", id: "hello" })).structuredContent).toEqual(viaHttp);
  });

  it("list_entries matches the HTTP list (sort / filter / fields / limit / offset / status)", async () => {
    const client = await connect(K);
    await call(client, "create_collection", {
      name: "items", fields: [{ name: "title", type: "text" }, { name: "n", type: "number" }],
    });
    for (let i = 1; i <= 5; i++) {
      await call(client, "create_entry", { collection: "items", data: { title: `t${i}`, n: i }, status: i % 2 ? "published" : "draft" });
    }
    const viaMcp = (await call(client, "list_entries", {
      collection: "items", status: "all", sort: "-n", filter: { n: { gte: "2" } }, fields: ["title"], limit: 2, offset: 1,
    })).structuredContent;
    const viaHttp = await http("/api/items?status=all&sort=-n&filter[n][gte]=2&fields=title&limit=2&offset=1");
    expect(viaMcp).toEqual(viaHttp);
    expect(viaMcp).toMatchObject({ total: 4, limit: 2, offset: 1 });
    const defaults = (await call(client, "list_entries", { collection: "items" })).structuredContent;
    expect(defaults).toEqual(await http("/api/items"));
    expect(defaults.total).toBe(3);
  });
});
