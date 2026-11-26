import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { z } from "zod";
import { createCollection, getCollection, listCollections, updateCollection } from "../core/collections";
import { requireRole, type Ctx } from "../core/context";
import {
  createEntry, getEntryRecord, getSingle, listEntryRecords, publishEntry, putSingle, unpublishEntry, updateEntry,
} from "../core/entries";
import { FemtoError } from "../core/errors";
import { createKey, listKeys, revokeKey } from "../core/keys";
import { importMediaFromUrl, listMedia, updateMedia, uploadMediaBase64 } from "../core/media";
import { presentEntries, presentEntry, presentMedia } from "../core/present";
import { createPreviewUrl, MAX_PREVIEW_TTL_SECONDS } from "../core/preview";
import { parseListParams } from "../core/query";
import { exportData, importData, resetSite, type ExportData } from "../core/transfer";
import { deletePermanently, emptyTrash, listTrash, restoreFromTrash, trashCollection, trashEntry, trashMedia } from "../core/trash";
import { authMiddleware, type AuthEnv } from "../http/auth";
import { errorBody, errorResponse } from "../http/errors";
import { VERSION } from "../version";

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** Runs a tool body. The result object is both the text and the structuredContent (always an object, like the HTTP API). */
async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { ...text(result), structuredContent: result };
  } catch (err) {
    return text(errorBody(err).body, true);
  }
}

const invalid = (path: string, message: string, expected: string, received: unknown) =>
  new FemtoError("validation_failed", "入力が不正です", { issues: [{ path, message, expected, received }] });

const trashNote = "This moves the item to the trash. It can be restored with restore_from_trash.";

function instructions(siteName: string): string {
  return [
    `femtocms is a headless CMS for the site "${siteName}". You manage content through these tools; there is no UI.`,
    "",
    "Workflow:",
    "1. list_collections to see what exists. get_collection(name) shows the fields, their types and descriptions. If the collection you need does not exist, create_collection.",
    '2. create_entry as a draft (the default). Put the content in `data`, using exactly the field names from get_collection. Markdown fields take Markdown; image fields take a media id (use upload_media first).',
    "3. get_preview_url to give the human a link to review the draft, then publish_entry when it is approved. unpublish_entry returns it to draft.",
    "4. list_entries returns published entries by default; pass status \"all\" or \"draft\" to see drafts.",
    "",
    "Errors: a failed call has isError = true and a JSON body { error: { code, message, issues?, hint? } }. Read `issues` (path + message + expected) and `hint`, fix the input and retry.",
    "Deletes (delete_entry, delete_collection, delete_media) move items to the trash and can be undone with restore_from_trash.",
    `Destructive operations (delete_permanently, empty_trash, reset_site, import_data in replace mode) require confirm = "${siteName}".`,
  ].join("\n");
}

const READ = { readOnlyHint: true } as const;
const DESTRUCTIVE = { destructiveHint: true } as const;
const WRITE = { destructiveHint: false } as const;

export function buildMcpServer(ctx: Ctx): McpServer {
  const confirmNote = `Set confirm to the site name: "${ctx.siteName}".`;
  const server = new McpServer(
    { name: "femtocms", version: VERSION },
    { instructions: instructions(ctx.siteName), jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  const collectionName = z.string().describe("Collection name (e.g. \"news\"). Use list_collections to see the names.");
  const entryId = z.string().describe("Entry id (e_...) or slug.");
  const confirm = z.string().describe(`Confirmation: the site name, "${ctx.siteName}".`);

  // --- collections ---------------------------------------------------------------------------------

  server.registerTool("list_collections", {
    description: "List all collections with their kind, public flag and fields. Call this first to see what content types exist.",
    annotations: READ,
  }, () => run(async () => ({ items: await listCollections(ctx) })));

  server.registerTool("get_collection", {
    description: "Get one collection's definition: its fields (name, type, label, description, required, options...). Call this before writing entries so you use the right field names and value types.",
    inputSchema: { name: collectionName },
    annotations: READ,
  }, ({ name }) => run(async () => ({ ...(await getCollection(ctx, name)) })));

  server.registerTool("create_collection", {
    annotations: WRITE,
    description:
      "Create a collection (a content type). `kind` is \"list\" (many entries, default) or \"single\" (exactly one entry, e.g. site settings or a landing page). " +
      "Field types: text, textarea, markdown, number, boolean, datetime, select (needs options), image (media id), reference (needs collection), list (needs nested fields), json. " +
      "Each field is { name, type, label?, description?, required?, default?, maxLength?, min?, max?, integer?, options?, multiple?, collection?, fields? }. " +
      "Write a clear `description` on each field: it is what later AI sessions read via get_collection. `required` is enforced only when publishing. The name cannot be changed later.",
    inputSchema: {
      name: z.string().describe("Collection name: lowercase letters, digits and hyphens, starting with a letter, max 40 chars (e.g. \"news\")."),
      label: z.string().optional().describe("Human-readable name (e.g. \"お知らせ\")."),
      description: z.string().optional().describe("What this collection is for."),
      kind: z.enum(["list", "single"]).optional().describe("\"list\" (default) for many entries, \"single\" for exactly one entry."),
      public: z.boolean().optional().describe("Whether published entries can be read without an API key. Default true."),
      fields: z.array(z.record(z.string(), z.unknown())).describe(
        "Field definitions, e.g. [{\"name\":\"title\",\"type\":\"text\",\"required\":true,\"description\":\"Headline\"},{\"name\":\"body\",\"type\":\"markdown\"}]. " +
        "Field names: a letter, then letters/digits/underscores (max 40); \"id\", \"slug\" and \"status\" are reserved.",
      ),
    },
  }, (args) => run(async () => ({ ...(await createCollection(ctx, args)) })));

  server.registerTool("update_collection", {
    annotations: WRITE,
    description:
      "Update a collection's label, description, public flag or fields. Pass only what changes in `patch`. " +
      "`fields`, when present, replaces the whole field list, so call get_collection first and send the full list. The collection name cannot change.",
    inputSchema: {
      name: collectionName,
      patch: z.record(z.string(), z.unknown()).describe(
        "Properties to change: any of label, description, kind, public, fields (the complete new field list).",
      ),
    },
  }, ({ name, patch }) => run(async () => ({ ...(await updateCollection(ctx, name, patch)) })));

  server.registerTool("delete_collection", {
    description: `Delete a collection together with its entries. ${trashNote}`,
    inputSchema: { name: collectionName },
    annotations: DESTRUCTIVE,
  }, ({ name }) => run(async () => {
    await trashCollection(ctx, name);
    return { deleted: true, name };
  }));

  // --- entries -------------------------------------------------------------------------------------

  server.registerTool("list_entries", {
    description:
      "List entries of a collection with pagination. By default only published entries are returned (status \"published\"); " +
      "pass status \"all\" or \"draft\" to see drafts. Results are { items, total, limit, offset }; markdown fields also come back as rendered HTML in `html`. " +
      "Default limit is 10 (max 100). Default sort is newest published first.",
    inputSchema: {
      collection: collectionName,
      limit: z.number().int().optional().describe("Page size, 1-100. Default 10."),
      offset: z.number().int().optional().describe("Number of entries to skip. Default 0."),
      sort: z.string().optional().describe("Comma-separated field names; prefix with - for descending (e.g. \"-publishedAt,title\"). Default \"-publishedAt\"."),
      filter: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])).optional().describe(
        "Filter by field. { \"title\": \"Hello\" } means equals; with an operator: { \"views\": { \"gte\": \"100\" } }. " +
        "Operators: eq, ne, lt, lte, gt, gte, contains, in (comma-separated values). Values are strings.",
      ),
      fields: z.array(z.string()).optional().describe("Only return these data fields (e.g. [\"title\"])."),
      expand: z.array(z.string()).optional().describe("Reference fields to expand into full entries instead of ids."),
      status: z.enum(["draft", "published", "all"]).optional().describe(
        "Which entries to list. Default \"published\" (drafts are hidden). Use \"all\" or \"draft\" to see drafts.",
      ),
    },
    annotations: READ,
  }, (args) => run(async () => {
    const qs = new URLSearchParams();
    if (args.limit !== undefined) qs.set("limit", String(args.limit));
    if (args.offset !== undefined) qs.set("offset", String(args.offset));
    if (args.sort !== undefined) qs.set("sort", args.sort);
    if (args.fields) qs.set("fields", args.fields.join(","));
    if (args.expand) qs.set("expand", args.expand.join(","));
    if (args.status !== undefined) qs.set("status", args.status);
    for (const [field, cond] of Object.entries(args.filter ?? {})) {
      if (typeof cond === "string") qs.set(`filter[${field}]`, cond);
      else for (const [op, v] of Object.entries(cond)) qs.set(`filter[${field}][${op}]`, v);
    }
    // Same parser as the HTTP query string, so both entrances read the parameters identically.
    const params = parseListParams(qs);
    const collection = await getCollection(ctx, args.collection);
    const opts = { fields: params.fields, expand: params.expand };
    if (collection.kind === "single") {
      return { ...(await presentEntry(ctx, collection, await getSingle(ctx, args.collection), opts)) };
    }
    const page = await listEntryRecords(ctx, args.collection, params);
    return { ...page, items: await presentEntries(ctx, collection, page.items, opts) };
  }));

  server.registerTool("get_entry", {
    description:
      "Get one entry by id or slug, including drafts. For a \"single\" collection omit `id`: it has exactly one entry and that entry is returned. " +
      "Result: { id, slug, status, createdAt, updatedAt, publishedAt, data, html }.",
    inputSchema: {
      collection: collectionName,
      id: entryId.optional().describe("Entry id (e_...) or slug. Omit only for a \"single\" collection."),
    },
    annotations: READ,
  }, ({ collection: name, id }) => run(async () => {
    const collection = await getCollection(ctx, name);
    if (id === undefined && collection.kind !== "single") {
      throw new FemtoError("bad_request", `コレクション "${name}" は list なので id が必要です`, {
        hint: "id (または slug) を指定してください。id は list_entries で調べられます",
      });
    }
    const record = id === undefined ? await getSingle(ctx, name) : await getEntryRecord(ctx, name, id);
    return { ...(await presentEntry(ctx, collection, record, {})) };
  }));

  server.registerTool("create_entry", {
    annotations: WRITE,
    description:
      "Create an entry in a collection. Before calling, call get_collection to see the fields and their descriptions. " +
      "Entries are created as drafts unless status is \"published\". Required fields are only enforced when publishing. " +
      "Put field values in `data` using the exact field names (images and references take an id). " +
      "For a \"single\" collection this sets its one entry (replacing the data if it already exists); `slug` and `publishedAt` are ignored there (use update_entry for publishedAt).",
    inputSchema: {
      collection: collectionName,
      data: z.record(z.string(), z.unknown()).describe("Field values keyed by field name, e.g. { \"title\": \"Hello\", \"body\": \"# Markdown\" }. Use null to leave a field unset."),
      slug: z.string().optional().describe("URL-friendly id: lowercase letters, digits, hyphens (max 64). Optional."),
      status: z.enum(["draft", "published"]).optional().describe("\"draft\" (default) or \"published\". Prefer draft, then get_preview_url, then publish_entry."),
      publishedAt: z.string().optional().describe("ISO 8601 publication date, e.g. \"2026-11-26T09:00:00Z\". Defaults to the time of publishing."),
    },
  }, ({ collection: name, data, slug, status, publishedAt }) => run(async () => {
    const collection = await getCollection(ctx, name);
    const record = collection.kind === "single"
      ? await putSingle(ctx, name, { data, status })
      : await createEntry(ctx, name, { data, slug, status, publishedAt });
    return { ...(await presentEntry(ctx, collection, record, {})) };
  }));

  server.registerTool("update_entry", {
    annotations: WRITE,
    description:
      "Update an entry. `data` is merged into the existing data: send only the fields you change (null clears a field). " +
      "Status is not changed here; use publish_entry / unpublish_entry. Call get_collection first if unsure about field names.",
    inputSchema: {
      collection: collectionName,
      id: entryId,
      data: z.record(z.string(), z.unknown()).optional().describe("Fields to change, keyed by field name. Merged into the existing data."),
      slug: z.string().optional().describe("New slug."),
      publishedAt: z.string().optional().describe("ISO 8601 datetime to set as the publication date, e.g. \"2026-11-26T09:00:00Z\"."),
    },
  }, ({ collection: name, id, data, slug, publishedAt }) => run(async () => {
    const record = await updateEntry(ctx, name, id, { data, slug, publishedAt });
    return { ...(await presentEntry(ctx, await getCollection(ctx, name), record, {})) };
  }));

  server.registerTool("delete_entry", {
    description: `Delete an entry. ${trashNote}`,
    inputSchema: { collection: collectionName, id: entryId },
    annotations: DESTRUCTIVE,
  }, ({ collection, id }) => run(async () => {
    await trashEntry(ctx, collection, id);
    return { deleted: true, id };
  }));

  for (const [name, action, verb] of [
    ["publish_entry", publishEntry, "Publish an entry so it is publicly readable. Required fields are enforced now; the error issues list what is missing."],
    ["unpublish_entry", unpublishEntry, "Turn a published entry back into a draft (it is no longer publicly readable)."],
  ] as const) {
    server.registerTool(name, {
      annotations: WRITE,
      description: verb,
      inputSchema: { collection: collectionName, id: entryId },
    }, ({ collection: c, id }) => run(async () => {
      const record = await action(ctx, c, id);
      return { ...(await presentEntry(ctx, await getCollection(ctx, c), record, {})) };
    }));
  }

  server.registerTool("get_preview_url", {
    annotations: WRITE,
    description:
      "Create a shareable preview link for an entry, including a draft. Anyone with the link can view the rendered page until it expires; no API key is needed. " +
      "Give this to the human so they can review a draft before you publish it.",
    inputSchema: {
      collection: collectionName,
      id: entryId,
      ttlSeconds: z.number().optional().describe(`Link lifetime in seconds, an integer from 1 to ${MAX_PREVIEW_TTL_SECONDS}. Default 86400 (24 hours).`),
    },
  }, ({ collection, id, ttlSeconds }) => run(async () => {
    if (ttlSeconds !== undefined && !(Number.isInteger(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= MAX_PREVIEW_TTL_SECONDS)) {
      throw invalid("ttlSeconds", `ttlSeconds は 1〜${MAX_PREVIEW_TTL_SECONDS} の整数（秒）です`, `integer 1..${MAX_PREVIEW_TTL_SECONDS}`, ttlSeconds);
    }
    return { ...(await createPreviewUrl(ctx, collection, id, { ttlSeconds })) };
  }));

  // --- media ---------------------------------------------------------------------------------------

  server.registerTool("upload_media", {
    annotations: WRITE,
    description:
      "Upload a file (image etc., max 20MB) to the media library. Provide exactly one source: `url` (the server downloads it) or `base64` (with `filename`). " +
      "Returns the media object; use its `id` in an image field of an entry.",
    inputSchema: {
      url: z.string().optional().describe("Public http(s) URL of the file to import. Use this OR base64."),
      base64: z.string().optional().describe("File content as standard base64 (a data: URL is also accepted). Requires filename. Use this OR url."),
      filename: z.string().optional().describe("File name with extension (e.g. \"hero.png\"). Required with base64; optional with url (defaults to the URL's last path segment)."),
      mimeType: z.string().optional().describe("MIME type, e.g. \"image/png\". Detected from the filename or response when omitted."),
      alt: z.string().optional().describe("Alternative text describing the image (accessibility)."),
    },
  }, ({ url, base64, filename, mimeType, alt }) => run(async () => {
    if ((url === undefined) === (base64 === undefined)) {
      throw new FemtoError("bad_request", "url か base64 のどちらか一方だけを指定してください", {
        hint: "公開 URL があれば url、無ければ base64 と filename を渡してください",
      });
    }
    if (base64 !== undefined && filename === undefined) {
      throw new FemtoError("bad_request", "base64 を使うときは filename が必要です", { hint: 'filename に "photo.png" のような拡張子付きの名前を指定してください' });
    }
    const media = url !== undefined
      ? await importMediaFromUrl(ctx, { url, filename, alt })
      : await uploadMediaBase64(ctx, { base64: base64!, filename: filename!, mimeType, alt });
    return { ...presentMedia(ctx, media) };
  }));

  server.registerTool("list_media", {
    description: "List uploaded media, newest first: { items, total, limit, offset }. Each item has id, url, filename, mimeType, size, width, height, alt.",
    inputSchema: {
      limit: z.number().int().optional().describe("Page size, 1-100. Default 10."),
      offset: z.number().int().optional().describe("Number of items to skip. Default 0."),
    },
    annotations: READ,
  }, ({ limit, offset }) => run(async () => {
    const page = await listMedia(ctx, { limit, offset });
    return { ...page, items: page.items.map((m) => presentMedia(ctx, m)) };
  }));

  server.registerTool("update_media", {
    annotations: WRITE,
    description: "Change a media file's alternative text. The file itself and its URL stay the same.",
    inputSchema: {
      id: z.string().describe("Media id (m_...). Use list_media to find it."),
      alt: z.string().describe("New alternative text describing the image (accessibility). An empty string clears it."),
    },
  }, ({ id, alt }) => run(async () => ({ ...presentMedia(ctx, await updateMedia(ctx, id, { alt })) })));

  server.registerTool("delete_media", {
    description: `Delete a media file. ${trashNote}`,
    inputSchema: { id: z.string().describe("Media id (m_...). Use list_media to find it.") },
    annotations: DESTRUCTIVE,
  }, ({ id }) => run(async () => {
    await trashMedia(ctx, id);
    return { deleted: true, id };
  }));

  // --- trash ---------------------------------------------------------------------------------------

  server.registerTool("list_trash", {
    description: "List items in the trash (entries, media, collections), newest first. Each has id, type, title, deletedAt.",
    annotations: READ,
  }, () => run(async () => ({ items: await listTrash(ctx) })));

  server.registerTool("restore_from_trash", {
    annotations: WRITE,
    description: "Restore an item from the trash by its id (from list_trash). Restoring a collection also restores the entries that were trashed with it.",
    inputSchema: { id: z.string().describe("Id of the trashed entry (e_...), media (m_...) or collection (c_...).") },
  }, ({ id }) => run(async () => ({ ...(await restoreFromTrash(ctx, id)) })));

  server.registerTool("delete_permanently", {
    description: `Permanently delete one item from the trash. This cannot be undone. ${confirmNote}`,
    inputSchema: { id: z.string().describe("Id of an item in the trash (from list_trash)."), confirm },
    annotations: DESTRUCTIVE,
  }, ({ id, confirm }) => run(async () => {
    await deletePermanently(ctx, id, confirm);
    return { deleted: true, id };
  }));

  server.registerTool("empty_trash", {
    description: `Permanently delete everything in the trash. This cannot be undone. ${confirmNote}`,
    inputSchema: { confirm },
    annotations: DESTRUCTIVE,
  }, ({ confirm }) => run(async () => ({ ...(await emptyTrash(ctx, confirm)) })));

  // --- keys ----------------------------------------------------------------------------------------

  server.registerTool("create_key", {
    annotations: WRITE,
    description:
      "Create an API key. The plaintext key is returned once and cannot be shown again, so pass it to the human right away. " +
      "Use role \"read\" for keys that only read content (e.g. a website's server), \"admin\" for full access.",
    inputSchema: {
      name: z.string().describe("A label for the key, e.g. \"website\" or \"claude-desktop\"."),
      role: z.enum(["admin", "read"]).describe("\"admin\" can do everything; \"read\" can read drafts and content but not change anything."),
    },
  }, (args) => run(async () => ({ ...(await createKey(ctx, args)) })));

  server.registerTool("list_keys", {
    description: "List API keys (never the secrets): id, name, role, createdAt, lastUsedAt, revokedAt.",
    annotations: READ,
  }, () => run(async () => ({ items: await listKeys(ctx) })));

  server.registerTool("revoke_key", {
    description: "Revoke an API key so it stops working. This cannot be undone. The last active admin key cannot be revoked.",
    inputSchema: { id: z.string().describe("Key id (k_...) from list_keys.") },
    annotations: DESTRUCTIVE,
  }, ({ id }) => run(async () => ({ ...(await revokeKey(ctx, id)) })));

  // --- export / import / reset ---------------------------------------------------------------------

  server.registerTool("export_data", {
    description: "Export all collections, entries and media metadata as one JSON object (the same format import_data accepts). Media files themselves are not included.",
    annotations: READ,
  }, () => run(async () => ({ ...(await exportData(ctx)) })));

  server.registerTool("import_data", {
    description:
      "Import data produced by export_data. mode \"merge\" adds/overwrites by id and keeps everything else; " +
      "mode \"replace\" first moves all existing content to the trash. " +
      `For replace: ${confirmNote} Media entries need a \`url\` the server can download.`,
    inputSchema: {
      data: z.record(z.string(), z.unknown()).describe("The object returned by export_data."),
      mode: z.enum(["merge", "replace"]).describe("\"merge\" or \"replace\" (replace requires confirm)."),
      confirm: z.string().optional().describe(`Required for mode "replace": the site name, "${ctx.siteName}".`),
    },
    annotations: DESTRUCTIVE,
  }, ({ data, mode, confirm }) => run(async () => ({ ...(await importData(ctx, { data: data as unknown as ExportData, mode, confirm })) })));

  server.registerTool("reset_site", {
    description: `Move all content (entries, media, collections) to the trash, leaving an empty site. API keys are kept. ${confirmNote}`,
    inputSchema: { confirm },
    annotations: DESTRUCTIVE,
  }, ({ confirm }) => run(async () => ({ ...(await resetSite(ctx, confirm)) })));

  return server;
}

/**
 * `/mcp`: stateless Streamable HTTP, admin keys only. A fresh server and transport per request.
 * Only POST (JSON-RPC, JSON responses) is served; GET (server-initiated SSE stream) and DELETE (session end)
 * have no meaning without sessions, so they answer 405 with `Allow: POST`.
 */
export const mcpApp = new Hono<AuthEnv>();

mcpApp.all("/", async (c) => {
  let ctx: Ctx;
  try {
    await authMiddleware(c, async () => {});
    ctx = c.get("ctx");
    requireRole(ctx, "admin");
  } catch (err) {
    const res = errorResponse(err);
    if (res.status === 401) res.headers.set("WWW-Authenticate", "Bearer");
    return res;
  }
  if (c.req.method !== "POST") {
    return Response.json(
      { error: { code: "method_not_allowed", message: "POST で JSON-RPC リクエストを送ってください", hint: "この MCP サーバはステートレスで、GET (SSE) と DELETE は使えません" } },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
