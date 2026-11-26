import {
  ADMIN, body, commonPaths, commonSchemas, infoDescription, noContent, ok, operation, OPTIONAL_AUTH, pathParam, queryParam,
} from "./openapi-common";
import { fieldToJsonSchema, objectSchema, pascalCase, ref, type JsonSchema } from "./openapi-fields";
import type { Collection, FieldDef } from "./types";
import { VERSION } from "../version";

// fieldToJsonSchema lives in openapi-fields.ts and the collection-independent parts in openapi-common.ts so this
// file stays focused on turning collections into schemas and paths.
export { fieldToJsonSchema };

type Obj = Record<string, unknown>;

interface Names { entry: string; data: string; write: string }

/** `<Name>Entry` / `<Name>Data` / `<Name>DataWrite`, sanitized for hyphens and made unique across collections. */
function componentNames(collections: Collection[]): Map<string, Names> {
  const used = new Set(Object.keys(commonSchemas()));
  const out = new Map<string, Names>();
  for (const c of collections) {
    let base = pascalCase(c.name) || "Collection";
    for (let i = 2; [`${base}Entry`, `${base}Data`, `${base}DataWrite`].some((n) => used.has(n)); i++) base = `${pascalCase(c.name)}${i}`;
    const names = { entry: `${base}Entry`, data: `${base}Data`, write: `${base}DataWrite` };
    Object.values(names).forEach((n) => used.add(n));
    out.set(c.name, names);
  }
  return out;
}

const SORTABLE_BUILTIN = ["createdAt", "updatedAt", "publishedAt", "slug"];
const isFilterable = (f: FieldDef) => f.type !== "list" && f.type !== "json";

function collectionSchemas(c: Collection, n: Names): Record<string, JsonSchema> {
  const required = c.fields.filter((f) => f.required).map((f) => f.name);
  const markdown = c.fields.filter((f) => f.type === "markdown").map((f) => f.name);
  return {
    [n.write]: {
      ...objectSchema(c.fields, "write"),
      description:
        "Fields to write. Fields marked required" + (required.length ? ` (${required.join(", ")})` : "") +
        " are NOT enforced here: they are only checked when the entry is published (status published, or POST .../publish), " +
        "so drafts may be incomplete. Types, lengths and ranges are always validated. null clears a field.",
    },
    [n.data]: { ...objectSchema(c.fields, "read"), description: "Stored field values. image fields are ApiMedia objects, reference fields are entry ids." },
    [n.entry]: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^e_[0-9a-z]{12}$" }, slug: { type: ["string", "null"] },
        status: { type: "string", enum: ["draft", "published"] },
        createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
        publishedAt: { type: ["string", "null"], format: "date-time" },
        data: ref(n.data),
        html: {
          type: "object", description: "Rendered HTML of each markdown field (raw HTML in the source is escaped).",
          properties: Object.fromEntries(markdown.map((m) => [m, { type: "string" }])),
        },
        expanded: {
          type: "array", items: { type: "string" },
          description: "Present only when expand replaced something: the reference fields whose data value is the referenced entry (or entries) instead of ids.",
        },
      },
      required: ["id", "slug", "status", "createdAt", "updatedAt", "publishedAt", "data", "html"],
    },
  };
}

function listParameters(c: Collection): Obj[] {
  const fieldNames = c.fields.filter(isFilterable).map((f) => f.name);
  const sortable = [...c.fields.filter((f) => isFilterable(f) && !(f.type === "select" && f.multiple)).map((f) => f.name), ...SORTABLE_BUILTIN];
  const references = c.fields.filter((f) => f.type === "reference").map((f) => f.name);
  return [
    queryParam("limit", "Page size (default 10, max 100).", { type: "integer", minimum: 1, maximum: 100, default: 10 }),
    queryParam("offset", "Rows to skip.", { type: "integer", minimum: 0, default: 0 }),
    queryParam("sort", `Comma-separated keys, "-" prefix for descending (e.g. -publishedAt,title). Keys: ${sortable.join(", ")}. Default: -publishedAt, then -createdAt.`),
    queryParam("filter[field]", `Equality filter on a field (e.g. filter[category]=info). Fields: ${[...fieldNames, ...SORTABLE_BUILTIN].join(", ")}.`),
    queryParam("filter[field][op]", "Operator filter: op is one of eq, ne, lt, lte, gt, gte, contains, in (in takes comma-separated values). Which operators apply depends on the field type; datetimes are ISO 8601, booleans true/false."),
    queryParam("fields", `Comma-separated field names to include in data (and html).${fieldNames.length ? ` Fields: ${c.fields.map((f) => f.name).join(", ")}.` : ""}`),
    queryParam("expand", references.length
      ? `Comma-separated reference fields to return as entry objects instead of ids (null when missing, trashed or not readable). Reference fields: ${references.join(", ")}.`
      : "Comma-separated reference fields to expand (this collection has none)."),
    queryParam("status", "Admin only (other roles always get published): published (default), draft, or all.", { type: "string", enum: ["published", "draft", "all"], default: "published" }),
  ];
}

function collectionPaths(c: Collection, n: Names): Record<string, Obj> {
  const entry = ref(n.entry);
  const idParam = pathParam("id", `Entry id (e_...) or slug in "${c.name}"`);
  const slugProp = { slug: { type: ["string", "null"], pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Optional unique URL slug." } };
  const publishedAt = { publishedAt: { type: "string", format: "date-time", description: "Defaults to the time of publishing." } };
  const tags = { tags: [c.name] };
  const readOnly = (summary: string, schema: JsonSchema, parameters: Obj[], errors: number[] = [404]) =>
    operation(summary, OPTIONAL_AUTH, ok("OK", schema), { ...tags, parameters }, errors);
  const entryParams = [idParam, listParameters(c).find((p) => p.name === "fields")!, listParameters(c).find((p) => p.name === "expand")!,
    queryParam("preview", "Preview token from POST .../preview: lets a draft be read without a key (responses are never cached).")];
  const lifecycle = (action: "publish" | "unpublish") => ({
    post: operation(action === "publish" ? "Publish (validates required fields)" : "Unpublish (back to draft)", ADMIN, ok("Entry", entry),
      { ...tags, parameters: [idParam] }, [404, 422]),
  });
  const preview = {
    post: operation("Create a preview URL for a draft", ADMIN,
      ok("Preview", { type: "object", properties: { url: { type: "string" }, token: { type: "string" }, expiresAt: { type: "string", format: "date-time" } }, required: ["url", "token", "expiresAt"] }),
      { ...tags, parameters: [idParam], requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { ttlSeconds: { type: "integer", minimum: 1, maximum: 2592000, description: "Default 24 hours." } } } } } } },
      [404, 422]),
  };
  const idBase = `/api/${c.name}/{id}`;

  if (c.kind === "single") {
    return {
      [`/api/${c.name}`]: {
        get: readOnly(`Get the ${c.name} entry`, entry, listParameters(c).filter((p) => p.name === "fields" || p.name === "expand")),
        put: operation("Create or replace the single entry's data (replaces data, not a merge)", ADMIN, ok("Entry", entry), {
          ...tags,
          requestBody: body({
            type: "object",
            properties: { data: ref(n.write), status: { type: "string", enum: ["draft", "published"], description: "Keeps the current status when omitted (draft for a new entry)." } },
            required: ["data"],
          }),
        }, [422]),
      },
      [`${idBase}/publish`]: lifecycle("publish"),
      [`${idBase}/unpublish`]: lifecycle("unpublish"),
      [`${idBase}/preview`]: preview,
    };
  }
  return {
    [`/api/${c.name}`]: {
      get: readOnly(`List ${c.name} entries`, { type: "object", properties: { items: { type: "array", items: entry }, total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } }, required: ["items", "total", "limit", "offset"] }, listParameters(c), []),
      post: operation(`Create a ${c.name} entry (draft unless status is published)`, ADMIN, ok("Created", entry, "201"), {
        ...tags,
        requestBody: body({
          type: "object",
          properties: { data: ref(n.write), ...slugProp, status: { type: "string", enum: ["draft", "published"], default: "draft" }, ...publishedAt },
          required: ["data"],
        }),
      }, [409, 422]),
    },
    [idBase]: {
      get: readOnly(`Get a ${c.name} entry`, entry, entryParams),
      patch: operation("Update an entry: data is merged over the stored data (send null to clear a field); status is unchanged", ADMIN, ok("Entry", entry), {
        ...tags, parameters: [idParam],
        requestBody: body({ type: "object", properties: { data: ref(n.write), ...slugProp, ...publishedAt } }),
      }, [404, 409, 422]),
      delete: operation("Move the entry to the trash", ADMIN, noContent, { ...tags, parameters: [idParam] }, [404]),
    },
    [`${idBase}/publish`]: lifecycle("publish"),
    [`${idBase}/unpublish`]: lifecycle("unpublish"),
    [`${idBase}/preview`]: preview,
  };
}

/** OpenAPI 3.1 document for the given (already role-filtered) collections. */
export function buildOpenApi(collections: Collection[], origin: string, siteName = "femtocms"): object {
  const names = componentNames(collections);
  const schemas: Record<string, JsonSchema> = commonSchemas();
  const paths: Record<string, Obj> = {};
  for (const c of collections) {
    const n = names.get(c.name)!;
    Object.assign(schemas, collectionSchemas(c, n));
    Object.assign(paths, collectionPaths(c, n));
  }
  Object.assign(paths, commonPaths(siteName));
  return {
    openapi: "3.1.0",
    info: { title: `femtocms — ${siteName}`, version: VERSION, description: infoDescription(siteName) },
    servers: [{ url: origin }],
    tags: collections.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) })),
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "fcms_admin_... (full access) or fcms_read_... (read-only). Optional for public reads." },
      },
      schemas,
    },
  };
}
