import { ref, type JsonSchema } from "./openapi-fields";

// Pieces of the OpenAPI document that do not depend on the collections: shared components and the fixed paths.

type Obj = Record<string, unknown>;

export const MAX_LIMIT_TEXT = "default 10, max 100";

export const infoDescription = (site: string): string => `
femtocms is a headless CMS (Cloudflare Workers + D1 + R2) for the site "${site}". This document is generated from the
current collection definitions, so it only lists the collections the caller's key can see.

## Authentication
Send \`Authorization: Bearer <key>\`. Keys start with \`fcms_admin_\` (full access) or \`fcms_read_\` (read-only: published
entries of every collection, including non-public ones, never drafts). Reading published entries of public collections
needs no key. Every write and every endpoint other than collection and entry reads needs an admin key. Missing or invalid keys give 401, a key that
is too weak gives 403.

## Errors
Every error response is \`{ "error": { "code", "message", "issues"?, "hint"? } }\`. \`issues\` is a list of
\`{ path, message, expected?, received? }\` (validation_failed, HTTP 422). \`hint\` says how to fix the request.
Codes: unauthorized 401, forbidden 403, not_found 404, validation_failed 422, conflict 409, bad_request 400,
confirmation_required 400, payload_too_large 413.

## Deleting
DELETE never destroys data: entries, media and collections move to the trash (GET /api/trash) and can be restored with
POST /api/trash/{id}/restore. Only permanently deleting from the trash, emptying the trash, POST /api/reset and a
\`replace\` import are irreversible or destructive; they require \`confirm\` set to the site name ("${site}") (query
parameter for DELETE, JSON body field for POST) and otherwise fail with confirmation_required.

## Entries
Entry data lives under \`data\`. \`required\` fields are only enforced when an entry is published (drafts may be incomplete);
types, lengths and ranges are always validated. Writing \`null\` for a field clears it.
`.trim();

const str: JsonSchema = { type: "string" };
const dt: JsonSchema = { type: "string", format: "date-time" };
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });
const obj = (properties: Obj, required: string[]): JsonSchema => ({ type: "object", properties, required });

const COMMON_FIELD_TYPES = [
  "text", "textarea", "markdown", "number", "boolean", "datetime", "select", "image", "reference", "list", "json",
];

const collectionInputProps: Obj = {
  name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$", description: "Cannot be changed after creation." },
  label: str, description: str, kind: { type: "string", enum: ["list", "single"] }, public: { type: "boolean", default: true },
  fields: { type: "array", items: ref("FieldDef") },
};

export const commonSchemas = (): Record<string, JsonSchema> => ({
  Error: obj({
    error: obj({
      code: { type: "string", enum: ["unauthorized", "forbidden", "not_found", "validation_failed", "conflict", "confirmation_required", "bad_request", "payload_too_large", "internal"] },
      message: str,
      issues: { type: "array", items: obj({ path: str, message: str, expected: str, received: {} }, ["path", "message"]) },
      hint: str,
    }, ["code", "message"]),
  }, ["error"]),
  ApiMedia: obj({
    id: { type: "string", pattern: "^m_[0-9a-z]{12}$" }, url: { type: "string", format: "uri" }, filename: str, mimeType: str,
    size: { type: "integer" }, width: nullable({ type: "integer" }), height: nullable({ type: "integer" }), alt: str, createdAt: dt,
  }, ["id", "url", "filename", "mimeType", "size", "width", "height", "alt", "createdAt"]),
  TrashItem: obj({
    type: { type: "string", enum: ["entry", "media", "collection"] }, id: str, title: str,
    collection: { type: "string", description: "Collection name (entries only)." }, deletedAt: dt,
  }, ["type", "id", "title", "deletedAt"]),
  ApiKeyInfo: obj({
    id: str, name: str, role: { type: "string", enum: ["admin", "read"] },
    prefix: { type: "string", description: "First 16 characters of the key; the full key is shown only once, at creation." },
    createdAt: dt, lastUsedAt: nullable(dt), revokedAt: nullable(dt),
  }, ["id", "name", "role", "prefix", "createdAt", "lastUsedAt", "revokedAt"]),
  FieldDef: {
    type: "object",
    properties: {
      name: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,39}$" },
      type: { type: "string", enum: COMMON_FIELD_TYPES },
      label: str, description: str,
      required: { type: "boolean", description: "Enforced only when publishing." },
      default: {}, maxLength: { type: "integer", minimum: 1 }, min: { type: "number" }, max: { type: "number" },
      integer: { type: "boolean" }, options: { type: "array", items: str, description: "select only." },
      multiple: { type: "boolean", description: "select / image / reference: store an array." },
      collection: { type: "string", description: "reference only: target collection name." },
      fields: { type: "array", items: ref("FieldDef"), description: "list only: sub-fields (no nested lists)." },
    },
    required: ["name", "type"], additionalProperties: false,
  },
  CollectionInput: {
    type: "object",
    properties: collectionInputProps,
    required: ["name", "fields"], additionalProperties: false,
  },
  CollectionUpdate: {
    description: "Any subset of the collection definition. `fields` replaces the whole field list.",
    type: "object",
    properties: collectionInputProps,
    additionalProperties: false,
  },
  Collection: obj({
    id: str, name: str, label: nullable(str), description: nullable(str), kind: { type: "string", enum: ["list", "single"] },
    public: { type: "boolean" }, fields: { type: "array", items: ref("FieldDef") }, createdAt: dt, updatedAt: dt,
  }, ["id", "name", "label", "description", "kind", "public", "fields", "createdAt", "updatedAt"]),
});

// --- response / parameter helpers ----------------------------------------------------------------

const json = (schema: JsonSchema) => ({ "application/json": { schema } });
const errorResponses = (...codes: number[]): Obj =>
  Object.fromEntries(codes.map((c) => [String(c), { description: ERROR_TEXT[c], content: json(ref("Error")) }]));
const ERROR_TEXT: Record<number, string> = {
  400: "bad_request / confirmation_required", 401: "unauthorized (missing or invalid key)", 403: "forbidden (key lacks permission)",
  404: "not_found", 409: "conflict", 413: "payload_too_large", 422: "validation_failed",
};

export const ok = (description: string, schema?: JsonSchema, status = "200"): Obj => ({
  [status]: schema ? { description, content: json(schema) } : { description },
});
export const noContent: Obj = { "204": { description: "Done (no body)" } };
export const body = (schema: JsonSchema, description?: string) =>
  ({ required: true, ...(description ? { description } : {}), content: json(schema) });
export const pathParam = (name: string, description: string) =>
  ({ name, in: "path", required: true, description, schema: str });
export const queryParam = (name: string, description: string, schema: JsonSchema = str) =>
  ({ name, in: "query", required: false, description, schema });
export const confirmParam = (site: string) =>
  queryParam("confirm", `Required: must equal the site name ("${site}").`);

export const ADMIN = [{ bearer: [] }];
/** Public callers need no key; a key still works (and widens what is visible). */
export const OPTIONAL_AUTH = [{}, { bearer: [] }];

export function operation(
  summary: string, security: Obj[], responses: Obj, extra: Obj = {}, errors: number[] = [],
): Obj {
  const codes = [...new Set([...(security === ADMIN ? [401, 403] : []), ...errors])];
  return { summary, security, ...extra, responses: { ...responses, ...errorResponses(...codes) } };
}

export function commonPaths(site: string): Record<string, Obj> {
  const mediaBody = {
    required: true,
    content: {
      "multipart/form-data": {
        schema: obj({ file: { type: "string", format: "binary" }, alt: str }, ["file"]),
      },
      "application/json": {
        schema: {
          oneOf: [
            obj({ url: { type: "string", format: "uri" }, filename: str, alt: str }, ["url"]),
            obj({ base64: str, filename: str, mimeType: str, alt: str }, ["base64", "filename"]),
          ],
        },
      },
    },
  };
  const id = pathParam("id", "Id");
  const confirm = confirmParam(site);
  const confirmBody = (extra: Obj, required: string[]) =>
    body(obj({ confirm: { type: "string", description: `Must equal the site name ("${site}").` }, ...extra }, required));
  const listMeta = { total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } };
  const page = (item: JsonSchema) => obj({ items: { type: "array", items: item }, ...listMeta }, ["items", "total", "limit", "offset"]);
  const paging = [queryParam("limit", `Page size (${MAX_LIMIT_TEXT}).`, { type: "integer", minimum: 1, maximum: 100, default: 10 }),
    queryParam("offset", "Rows to skip.", { type: "integer", minimum: 0, default: 0 })];

  return {
    "/api/collections": {
      get: operation("List collections visible to the caller", OPTIONAL_AUTH, ok("Collections", obj({ items: { type: "array", items: ref("Collection") } }, ["items"]))),
      post: operation("Create a collection", ADMIN, ok("Created", ref("Collection"), "201"), { requestBody: body(ref("CollectionInput")) }, [409, 422]),
    },
    "/api/collections/{name}": {
      get: operation("Get a collection definition", OPTIONAL_AUTH, ok("Collection", ref("Collection")), { parameters: [pathParam("name", "Collection name")] }, [404]),
      patch: operation("Update a collection (name cannot change)", ADMIN, ok("Updated", ref("Collection")),
        { parameters: [pathParam("name", "Collection name")], requestBody: body(ref("CollectionUpdate")) }, [404, 409, 422]),
      delete: operation("Move a collection and its entries to the trash", ADMIN, noContent, { parameters: [pathParam("name", "Collection name")] }, [404]),
    },
    "/api/media": {
      get: operation("List media", ADMIN, ok("Media", page(ref("ApiMedia"))), { parameters: paging }),
      post: operation("Upload media (multipart file, JSON url, or JSON base64). Max 20MB.", ADMIN, ok("Created", ref("ApiMedia"), "201"),
        { requestBody: mediaBody }, [400, 413, 422]),
    },
    "/api/media/{id}": {
      put: operation("Upload raw bytes under a chosen media id (used by import)", ADMIN, ok("Stored", ref("ApiMedia")), {
        parameters: [pathParam("id", "Media id (m_ + 12 chars of [0-9a-z])"), { ...queryParam("filename", "File name"), required: true }, queryParam("alt", "Alt text")],
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      }, [400, 413]),
      patch: operation("Update media alt text", ADMIN, ok("Updated", ref("ApiMedia")), { parameters: [id], requestBody: body(obj({ alt: str }, [])) }, [404]),
      delete: operation("Move media to the trash", ADMIN, noContent, { parameters: [id] }, [404]),
    },
    "/api/trash": {
      get: operation("List trashed entries, media and collections", ADMIN, ok("Trash", obj({ items: { type: "array", items: ref("TrashItem") } }, ["items"]))),
      delete: operation("Empty the trash permanently (requires confirm)", ADMIN, ok("Deleted count", obj({ deleted: { type: "integer" } }, ["deleted"])),
        { parameters: [{ ...confirm, required: true }] }, [400]),
    },
    "/api/trash/{id}/restore": {
      post: operation("Restore an item from the trash", ADMIN, ok("Restored", ref("TrashItem")), { parameters: [id] }, [404, 409]),
    },
    "/api/trash/{id}": {
      delete: operation("Permanently delete one trashed item (requires confirm)", ADMIN, noContent, { parameters: [id, { ...confirm, required: true }] }, [400, 404]),
    },
    "/api/keys": {
      get: operation("List API keys (never the secrets)", ADMIN, ok("Keys", obj({ items: { type: "array", items: ref("ApiKeyInfo") } }, ["items"]))),
      post: operation("Create an API key. The plaintext key is returned only once.", ADMIN,
        ok("Created", obj({ key: str, info: ref("ApiKeyInfo") }, ["key", "info"]), "201"),
        { requestBody: body(obj({ name: str, role: { type: "string", enum: ["admin", "read"] } }, ["name", "role"])) }, [422]),
    },
    "/api/keys/{id}": {
      delete: operation("Revoke an API key (the last active admin key cannot be revoked)", ADMIN, ok("Revoked", ref("ApiKeyInfo")), { parameters: [id] }, [404, 409]),
    },
    "/api/export": {
      get: operation("Export collections, entries and media metadata (no keys, no settings, no trash)", ADMIN,
        ok("Export", { type: "object", properties: { format: { const: "femtocms-export" }, version: { const: 1 } }, required: ["format", "version"] })),
    },
    "/api/import": {
      post: operation("Import an export. mode=replace trashes everything first and requires confirm.", ADMIN,
        ok("Counts", obj({ collections: { type: "integer" }, entries: { type: "integer" }, media: { type: "integer" } }, ["collections", "entries", "media"])),
        { requestBody: confirmBody({ mode: { type: "string", enum: ["merge", "replace"] }, data: { type: "object", description: "The /api/export document." } }, ["mode", "data"]) }, [400, 422]),
    },
    "/api/reset": {
      post: operation("Move every collection, entry and media to the trash (requires confirm)", ADMIN, ok("Trashed count", obj({ trashed: { type: "integer" } }, ["trashed"])),
        { requestBody: confirmBody({}, ["confirm"]) }, [400]),
    },
  };
}
