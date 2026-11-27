import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import type { FemtoClient } from "../client";
import { print, table } from "../output";
import type { Collection, FieldDef, FieldType } from "../../../worker/src/core/types";
import { clientFor, guarded, isJson, resolveConfirm, type ConfirmOpts } from "./admin";

type Obj = Record<string, unknown>;
/** `[collection, idOrSlug]`: commands with two positional arguments take them as a tuple. */
export type EntryRef = [collection: string, id: string];

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const collect = (v: string, prev: string[]) => [...prev, v];

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Could not read ${what} ${path}: ${(e as Error).message}`);
  }
}

// --- collections --------------------------------------------------------------------------------

const FIELD_TYPES: readonly FieldType[] = [
  "text", "textarea", "markdown", "number", "boolean", "datetime", "select", "image", "reference", "list", "json",
];

/** A collection definition file: `.json` is JSON, anything else is YAML (which also reads JSON). */
function readDefinition(path: string): Obj {
  const text = readText(path, "definition file");
  let parsed: unknown;
  try {
    parsed = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new Error(`Could not read ${path} (it is not valid JSON or YAML): ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${path} must contain a collection definition object`);
  return parsed;
}

function parseFieldFlag(spec: string): FieldDef {
  const [name, type, flag, ...rest] = spec.split(":");
  if (!name || !type || rest.length > 0) throw new Error(`--field has an invalid format: "${spec}" (expected name:type[:required])`);
  if (!FIELD_TYPES.includes(type as FieldType)) {
    throw new Error(`--field "${spec}" has an unknown type "${type}". Available types: ${FIELD_TYPES.join(", ")}`);
  }
  if (flag !== undefined && flag !== "required") {
    throw new Error(`--field "${spec}": the third part can only be "required"`);
  }
  return flag ? { name, type: type as FieldType, required: true } : { name, type: type as FieldType };
}

export interface CollectionsCreateOpts { file?: string; name?: string; label?: string; kind?: string; field?: string[] }

export async function collectionsList(client: FemtoClient): Promise<unknown> {
  return client.request("GET", "/api/collections");
}

export async function collectionsGet(client: FemtoClient, name: string): Promise<unknown> {
  return client.request("GET", `/api/collections/${encodeURIComponent(name)}`);
}

export async function collectionsCreate(client: FemtoClient, opts: CollectionsCreateOpts): Promise<unknown> {
  const def: Obj = opts.file ? readDefinition(opts.file) : {};
  if (opts.name !== undefined) def.name = opts.name;
  if (opts.label !== undefined) def.label = opts.label;
  if (opts.kind !== undefined) def.kind = opts.kind;
  if (opts.field?.length) def.fields = opts.field.map(parseFieldFlag);
  return client.request("POST", "/api/collections", { json: def });
}

export async function collectionsUpdate(client: FemtoClient, name: string, opts: { file?: string }): Promise<unknown> {
  if (!opts.file) throw new Error("Pass --file with the collection definition (JSON or YAML) to update with");
  return client.request("PATCH", `/api/collections/${encodeURIComponent(name)}`, { json: readDefinition(opts.file) });
}

export async function collectionsDelete(client: FemtoClient, name: string): Promise<unknown> {
  await client.request("DELETE", `/api/collections/${encodeURIComponent(name)}`);
  return { trashed: name };
}

// --- entries ------------------------------------------------------------------------------------

export interface EntriesListOpts {
  limit?: string | number;
  offset?: string | number;
  sort?: string;
  filter?: string[];
  fields?: string;
  expand?: string;
  status?: string;
  after?: string;
  before?: string;
}

export interface EntryWriteOpts {
  data?: string;
  set?: string[];
  file?: string;
  bodyField?: string;
  slug?: string;
  publish?: boolean;
  publishedAt?: string;
}

/** `k=v` -> `filter[k]=v`, `k[op]=v` -> `filter[k][op]=v`. */
function filterQuery(spec: string): [string, string] {
  const m = /^([^[\]=]+)(?:\[([^[\]=]+)\])?=(.*)$/s.exec(spec);
  if (!m) throw new Error(`--filter has an invalid format: "${spec}" (expected k=v or k[op]=v)`);
  const [, key, op, value] = m;
  return [op ? `filter[${key}][${op}]` : `filter[${key}]`, value!];
}

export async function entriesList(client: FemtoClient, collection: string, opts: EntriesListOpts): Promise<unknown> {
  const query: Record<string, string | undefined> = {
    limit: opts.limit === undefined ? undefined : String(opts.limit),
    offset: opts.offset === undefined ? undefined : String(opts.offset),
    sort: opts.sort,
    fields: opts.fields,
    expand: opts.expand,
    status: opts.status,
    after: opts.after,
    before: opts.before,
  };
  for (const spec of opts.filter ?? []) {
    const [k, v] = filterQuery(spec);
    query[k] = v;
  }
  return client.request("GET", `/api/${encodeURIComponent(collection)}`, { query });
}

/** With no id, a single collection returns its one entry (like MCP get_entry); a list collection needs an id. */
export async function entriesGet(client: FemtoClient, [collection, id]: [collection: string, id?: string]): Promise<unknown> {
  if (id === undefined) {
    const def = await client.request<Collection>("GET", `/api/collections/${encodeURIComponent(collection)}`);
    if (def.kind !== "single") throw new Error(`The collection "${collection}" is a list collection. Give the entry id or slug`);
    return client.request("GET", `/api/${encodeURIComponent(collection)}`);
  }
  return client.request("GET", entryPath(collection, id));
}

const entryPath = (collection: string, id: string, action = "") =>
  `/api/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${action}`;

/** Splits `---\n<yaml>\n---\n<body>`. Only a file that starts with `---\n` has front matter. */
function splitFrontMatter(text: string, path: string): { front: Obj; body: string } {
  if (!/^---\r?\n/.test(text)) return { front: {}, body: text };
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error(`The front matter in ${path} is not closed (the second --- is missing)`);
  let front: unknown;
  try {
    front = parseYaml(m[1] ?? "");
  } catch (e) {
    throw new Error(`Could not parse the front matter in ${path} as YAML: ${(e as Error).message}`);
  }
  if (front === null || front === undefined) front = {};
  if (!isObject(front)) throw new Error(`The front matter in ${path} must be a key: value mapping`);
  return { front, body: text.slice(m[0].length) };
}

function coerce(field: FieldDef, raw: string): unknown {
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`--set ${field.name}=${raw}: give a number`);
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`--set ${field.name}=${raw}: give true or false`);
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`--set ${field.name}=${raw}: not valid JSON`);
      }
    case "select":
    case "image":
    case "reference":
      return field.multiple ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw;
    default:
      return raw;
  }
}

function parseDataFlag(text: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse --data as JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error("--data must be a JSON object ({...})");
  return parsed;
}

/** Entry data from --data, then --file (front matter + body), then --set (which wins). Throws before any write. */
async function buildEntryInput(
  client: FemtoClient, collection: string, opts: EntryWriteOpts, needsSchema: boolean,
): Promise<{ data: Obj; slug?: string; kind?: Collection["kind"] }> {
  const data: Obj = opts.data === undefined ? {} : parseDataFlag(opts.data);
  const sets = opts.set ?? [];
  const def = needsSchema || sets.length > 0 || opts.file !== undefined
    ? await client.request<Collection>("GET", `/api/collections/${encodeURIComponent(collection)}`)
    : undefined;
  const fields = def?.fields ?? [];
  const names = () => fields.map((f) => f.name).join(", ");

  if (opts.file !== undefined) {
    const { front, body } = splitFrontMatter(readText(opts.file, "file"), opts.file);
    Object.assign(data, front);
    const text = body.replace(/^(?:\r?\n)+/, "").trimEnd();
    if (text !== "") {
      if (opts.bodyField !== undefined && !fields.some((f) => f.name === opts.bodyField)) {
        throw new Error(`--body-field "${opts.bodyField}" is not a field of the collection "${collection}". Fields: ${names()}`);
      }
      const target = opts.bodyField ?? fields.find((f) => f.type === "markdown")?.name;
      if (!target) {
        throw new Error(
          `The collection "${collection}" has no markdown field to put the body in. Pass --body-field, or leave the body empty`,
        );
      }
      data[target] = text;
    }
  }

  for (const spec of sets) {
    const i = spec.indexOf("=");
    if (i <= 0) throw new Error(`--set has an invalid format: "${spec}" (expected k=v)`);
    const key = spec.slice(0, i);
    const field = fields.find((f) => f.name === key);
    if (!field) throw new Error(`--set field "${key}" is not a field of the collection "${collection}". Fields: ${names()}`);
    data[key] = coerce(field, spec.slice(i + 1));
  }
  return { data, slug: opts.slug, kind: def?.kind };
}

export async function entriesCreate(client: FemtoClient, collection: string, opts: EntryWriteOpts): Promise<unknown> {
  // create needs the collection's kind: a single collection is written with PUT (like MCP create_entry).
  const { data, slug, kind } = await buildEntryInput(client, collection, opts, true);
  const publishedAt = opts.publishedAt;
  if (kind === "single") {
    if (slug !== undefined) throw new Error(`--slug cannot be used: the collection "${collection}" is a single collection`);
    if (publishedAt !== undefined) {
      throw new Error(`--published-at cannot be used when creating: the collection "${collection}" is a single collection. Set it after creating with entries update <collection> <id> --published-at`);
    }
    return client.request("PUT", `/api/${encodeURIComponent(collection)}`, {
      json: { data, ...(opts.publish && { status: "published" }) },
    });
  }
  return client.request("POST", `/api/${encodeURIComponent(collection)}`, {
    json: {
      data, ...(slug !== undefined && { slug }), ...(opts.publish && { status: "published" }),
      ...(publishedAt !== undefined && { publishedAt }),
    },
  });
}

export async function entriesUpdate(client: FemtoClient, [collection, id]: EntryRef, opts: EntryWriteOpts): Promise<unknown> {
  const { data, slug } = await buildEntryInput(client, collection, opts, false);
  const publishedAt = opts.publishedAt;
  const changed = Object.keys(data).length > 0 || slug !== undefined || publishedAt !== undefined;
  if (!changed && !opts.publish) {
    throw new Error("Nothing to update. Pass one of --data, --set, --file, --slug, --published-at or --publish");
  }
  let result: unknown;
  if (changed) {
    result = await client.request("PATCH", entryPath(collection, id), {
      json: {
        ...(Object.keys(data).length > 0 && { data }), ...(slug !== undefined && { slug }),
        ...(publishedAt !== undefined && { publishedAt }),
      },
    });
  }
  return opts.publish ? client.request("POST", entryPath(collection, id, "/publish")) : result;
}

export async function entriesDelete(client: FemtoClient, [collection, id]: EntryRef, _opts: object): Promise<unknown> {
  await client.request("DELETE", entryPath(collection, id));
  return { trashed: id };
}

export async function entriesPublish(client: FemtoClient, [collection, id]: EntryRef, _opts: object): Promise<unknown> {
  return client.request("POST", entryPath(collection, id, "/publish"));
}

export async function entriesUnpublish(client: FemtoClient, [collection, id]: EntryRef, _opts: object): Promise<unknown> {
  return client.request("POST", entryPath(collection, id, "/unpublish"));
}

// --- media / preview ----------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
  wav: "audio/wav", txt: "text/plain", csv: "text/csv", json: "application/json",
};

export const mimeFromPath = (path: string): string =>
  MIME_BY_EXT[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";

export interface MediaUploadOpts { alt?: string; url?: string; filename?: string }

/** A local file (multipart) or, with --url, a remote file the server downloads (JSON { url }). Exactly one of the two. */
export async function mediaUpload(client: FemtoClient, path: string | undefined, opts: MediaUploadOpts): Promise<unknown> {
  if ((path === undefined) === (opts.url === undefined)) {
    throw new Error("Give either the path of a file to upload or --url <url>, not both");
  }
  if (opts.url !== undefined) {
    return client.request("POST", "/api/media", {
      json: {
        url: opts.url, ...(opts.alt !== undefined && { alt: opts.alt }), ...(opts.filename !== undefined && { filename: opts.filename }),
      },
    });
  }
  const bytes = new Uint8Array(readFileSync(path!));
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mimeFromPath(path!) }), opts.filename ?? basename(path!));
  if (opts.alt !== undefined) form.set("alt", opts.alt);
  return client.request("POST", "/api/media", { body: form });
}

export async function mediaUpdate(client: FemtoClient, id: string, opts: { alt?: string }): Promise<unknown> {
  if (opts.alt === undefined) throw new Error("Nothing to change. Pass --alt <text>");
  return client.request("PATCH", `/api/media/${encodeURIComponent(id)}`, { json: { alt: opts.alt } });
}

export async function mediaList(client: FemtoClient, opts: { limit?: string | number; offset?: string | number }): Promise<unknown> {
  return client.request("GET", "/api/media", {
    query: {
      limit: opts.limit === undefined ? undefined : String(opts.limit),
      offset: opts.offset === undefined ? undefined : String(opts.offset),
    },
  });
}

export async function mediaDelete(client: FemtoClient, id: string, _opts: object): Promise<unknown> {
  await client.request("DELETE", `/api/media/${encodeURIComponent(id)}`);
  return { trashed: id };
}

/** Same bounds as the server (core/preview.ts MAX_PREVIEW_TTL_SECONDS): 1 second to 30 days. */
const MAX_PREVIEW_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function previewCmd(client: FemtoClient, [collection, id]: EntryRef, opts: { ttl?: string }): Promise<unknown> {
  if (opts.ttl === undefined) return client.request("POST", entryPath(collection, id, "/preview"));
  const ttl = /^\d+$/.test(opts.ttl) ? Number(opts.ttl) : NaN;
  if (!(Number.isInteger(ttl) && ttl >= 1 && ttl <= MAX_PREVIEW_TTL_SECONDS)) {
    throw new Error(`--ttl must be an integer number of seconds from 1 to ${MAX_PREVIEW_TTL_SECONDS} (got: "${opts.ttl}")`);
  }
  return client.request("POST", entryPath(collection, id, "/preview"), { json: { ttlSeconds: ttl } });
}

// --- trash --------------------------------------------------------------------------------------

export async function trashList(client: FemtoClient): Promise<unknown> {
  return client.request("GET", "/api/trash");
}

export async function trashRestore(client: FemtoClient, id: string, _opts: object): Promise<unknown> {
  return client.request("POST", `/api/trash/${encodeURIComponent(id)}/restore`);
}

export async function trashDelete(client: FemtoClient, id: string, opts: ConfirmOpts): Promise<unknown> {
  const confirm = await resolveConfirm(opts, `This deletes ${id} for good. It cannot be undone.`);
  await client.request("DELETE", `/api/trash/${encodeURIComponent(id)}`, { query: { confirm } });
  return { deleted: id };
}

export async function trashEmpty(client: FemtoClient, opts: ConfirmOpts): Promise<unknown> {
  const confirm = await resolveConfirm(opts, "This empties the trash for good. It cannot be undone.");
  return client.request("DELETE", "/api/trash", { query: { confirm } });
}

// --- human output -------------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

function humanList(header: string[], rows: string[][]): string {
  return rows.length === 0 ? "(none)" : table([header, ...rows]);
}

function humanEntries(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.items)) return JSON.stringify(result, null, 2);
  const rows = (result.items as Obj[]).map((e) => {
    const data = isObject(e.data) ? e.data : {};
    const title = Object.values(data).find((v) => typeof v === "string");
    return [str(e.id), str(e.slug) || "-", str(e.status), str(e.publishedAt) || "-", str(title)];
  });
  const footer = typeof result.total === "number" ? `\nTotal: ${result.total}` : "";
  return humanList(["id", "slug", "status", "publishedAt", "title"], rows) + footer;
}

const items = (r: unknown): Obj[] => (isObject(r) && Array.isArray(r.items) ? (r.items as Obj[]) : []);

// --- commander wiring ---------------------------------------------------------------------------

export function registerContent(program: Command): void {
  const out = (cmd: Command, result: unknown, human?: (r: unknown) => string) => print(result, { json: isJson(cmd), human });

  const collections = program.command("collections").description("Manage collections (schemas)");
  collections
    .command("list")
    .description("List collections")
    .action(guarded(async (_o: object, cmd: Command) => {
      out(cmd, await collectionsList(clientFor(cmd)), (r) =>
        humanList(["name", "kind", "fields", "label"], items(r).map((c) => [
          str(c.name), str(c.kind), String(Array.isArray(c.fields) ? c.fields.length : 0), str(c.label),
        ])));
    }));
  collections
    .command("get <name>")
    .description("Show a collection definition")
    .action(guarded(async (name: string, _o: object, cmd: Command) => {
      out(cmd, await collectionsGet(clientFor(cmd), name));
    }));
  collections
    .command("create")
    .description("Create a collection (flags override the definition in --file)")
    .option("--file <path>", "Definition file (.json / .yaml / .yml)")
    .option("--name <name>", "Collection name")
    .option("--label <label>", "Display label")
    .option("--kind <kind>", "list (many entries) or single (one entry)")
    .option("--field <name:type[:required]>", "Field (repeatable; replaces the fields in --file)", collect, [])
    .action(guarded(async (o: CollectionsCreateOpts, cmd: Command) => {
      out(cmd, await collectionsCreate(clientFor(cmd), o), (r) => `Created: ${str((r as Obj).name)}`);
    }));
  collections
    .command("update <name>")
    .description("Update a collection definition (PATCHes the content of --file)")
    .option("--file <path>", "Definition file (.json / .yaml / .yml)")
    .action(guarded(async (name: string, o: { file?: string }, cmd: Command) => {
      out(cmd, await collectionsUpdate(clientFor(cmd), name, o), () => `Updated: ${name}`);
    }));
  collections
    .command("delete <name>")
    .description("Move a collection to the trash")
    .action(guarded(async (name: string, _o: object, cmd: Command) => {
      out(cmd, await collectionsDelete(clientFor(cmd), name), () => `Moved to the trash: ${name}`);
    }));

  const entries = program.command("entries").description("Manage entries");
  entries
    .command("list <collection>")
    .description("List entries (published only by default; use --status draft or all for drafts)")
    .option("--limit <n>", "Number of items (default 10, max 100)")
    .option("--offset <n>", "Start position")
    .option("--sort <keys>", "Sort order (e.g. -publishedAt; comma-separated, a - prefix sorts descending)")
    .option("--filter <k=v>", "Filter (k=v or k[op]=v; repeatable)", collect, [])
    .option("--fields <a,b>", "Fields to return")
    .option("--expand <a,b>", "Reference fields to expand")
    .option("--status <status>", "draft | published | all (default: published; use draft or all to see drafts)")
    .option("--after <idOrSlug>", "Return only entries after this one (in this sort order); with --limit 1, the next entry")
    .option("--before <idOrSlug>", "Return only entries before this one (in this sort order); results keep the same direction as the list")
    .action(guarded(async (c: string, o: EntriesListOpts, cmd: Command) => {
      out(cmd, await entriesList(clientFor(cmd), c, o), humanEntries);
    }));
  entries
    .command("get <collection> [id]")
    .description("Get one entry (by id or slug; the id can be omitted for a single collection)")
    .action(guarded(async (c: string, id: string | undefined, _o: object, cmd: Command) => {
      out(cmd, await entriesGet(clientFor(cmd), [c, id]));
    }));

  const writeOptions = (cmd: Command) =>
    cmd
      .option("--data <json>", "Entry data as a JSON object")
      .option("--set <k=v>", "Field value (repeatable; converted to the field type)", collect, [])
      .option("--file <path>", "Markdown file (the YAML front matter becomes the data, the body goes to --body-field)")
      .option("--body-field <name>", "Field that receives the body (default: the first markdown field)")
      .option("--slug <slug>", "slug")
      .option("--published-at <iso>", "Publish date and time (ISO 8601, e.g. 2026-11-26T09:00:00Z)")
      .option("--publish", "Publish the entry");
  const written = (verb: string) => (r: unknown) => `${verb}: ${str((r as Obj).id)} (${str((r as Obj).status)})`;

  writeOptions(entries.command("create <collection>").description("Create an entry (sources in priority order: --data, --file, --set)")).action(
    guarded(async (c: string, o: EntryWriteOpts, cmd: Command) => {
      out(cmd, await entriesCreate(clientFor(cmd), c, o), written("Created"));
    }),
  );
  writeOptions(entries.command("update <collection> <id>").description("Update an entry (--publish publishes it after the update)")).action(
    guarded(async (c: string, id: string, o: EntryWriteOpts, cmd: Command) => {
      out(cmd, await entriesUpdate(clientFor(cmd), [c, id], o), written("Updated"));
    }),
  );
  entries
    .command("delete <collection> <id>")
    .description("Move an entry to the trash")
    .action(guarded(async (c: string, id: string, o: object, cmd: Command) => {
      out(cmd, await entriesDelete(clientFor(cmd), [c, id], o), () => `Moved to the trash: ${id}`);
    }));
  entries
    .command("publish <collection> <id>")
    .description("Publish an entry")
    .action(guarded(async (c: string, id: string, o: object, cmd: Command) => {
      out(cmd, await entriesPublish(clientFor(cmd), [c, id], o), written("Published"));
    }));
  entries
    .command("unpublish <collection> <id>")
    .description("Turn an entry back into a draft")
    .action(guarded(async (c: string, id: string, o: object, cmd: Command) => {
      out(cmd, await entriesUnpublish(clientFor(cmd), [c, id], o), written("Reverted to draft"));
    }));

  const media = program.command("media").description("Manage media");
  media
    .command("upload [file]")
    .description("Upload a file (a local file or --url, not both)")
    .option("--url <url>", "http(s) URL for the server to download (instead of a file)")
    .option("--alt <text>", "Alt text")
    .option("--filename <name>", "File name to store (default: the file name, or the end of the URL)")
    .action(guarded(async (file: string | undefined, o: MediaUploadOpts, cmd: Command) => {
      out(cmd, await mediaUpload(clientFor(cmd), file, o), (r) => `${str((r as Obj).id)}  ${str((r as Obj).url)}`);
    }));
  media
    .command("update <id>")
    .description("Change the alt text of media (the file and URL stay as they are)")
    .option("--alt <text>", "New alt text (an empty string clears it)")
    .action(guarded(async (id: string, o: { alt?: string }, cmd: Command) => {
      out(cmd, await mediaUpdate(clientFor(cmd), id, o), () => `Updated: ${id}`);
    }));
  media
    .command("list")
    .description("List media")
    .option("--limit <n>", "Number of items (default 10, max 100)")
    .option("--offset <n>", "Start position")
    .action(guarded(async (o: { limit?: string; offset?: string }, cmd: Command) => {
      out(cmd, await mediaList(clientFor(cmd), o), (r) =>
        humanList(["id", "filename", "mimeType", "size", "alt"], items(r).map((m) => [
          str(m.id), str(m.filename), str(m.mimeType), str(m.size), str(m.alt),
        ])));
    }));
  media
    .command("delete <id>")
    .description("Move media to the trash")
    .action(guarded(async (id: string, o: object, cmd: Command) => {
      out(cmd, await mediaDelete(clientFor(cmd), id, o), () => `Moved to the trash: ${id}`);
    }));

  program
    .command("preview <collection> <id>")
    .description("Print a preview URL for a draft")
    .option("--ttl <seconds>", "Lifetime in seconds (1 to 2592000; default 86400 = 24 hours)")
    .action(guarded(async (c: string, id: string, o: { ttl?: string }, cmd: Command) => {
      out(cmd, await previewCmd(clientFor(cmd), [c, id], o), (r) => str((r as Obj).url));
    }));

  const trash = program.command("trash").description("Manage the trash");
  trash
    .command("list")
    .description("List what is in the trash")
    .action(guarded(async (_o: object, cmd: Command) => {
      out(cmd, await trashList(clientFor(cmd)), (r) =>
        humanList(["type", "id", "title", "deletedAt"], items(r).map((t) => [str(t.type), str(t.id), str(t.title), str(t.deletedAt)])));
    }));
  trash
    .command("restore <id>")
    .description("Restore an item from the trash")
    .action(guarded(async (id: string, o: object, cmd: Command) => {
      out(cmd, await trashRestore(clientFor(cmd), id, o), () => `Restored: ${id}`);
    }));
  trash
    .command("delete <id>")
    .description("Delete for good (requires the site name)")
    .option("--confirm <site>", "Site name (if omitted, an interactive terminal asks for it)")
    .action(guarded(async (id: string, o: ConfirmOpts, cmd: Command) => {
      out(cmd, await trashDelete(clientFor(cmd), id, o), () => `Deleted for good: ${id}`);
    }));
  trash
    .command("empty")
    .description("Empty the trash (requires the site name)")
    .option("--confirm <site>", "Site name (if omitted, an interactive terminal asks for it)")
    .action(guarded(async (o: ConfirmOpts, cmd: Command) => {
      out(cmd, await trashEmpty(clientFor(cmd), o), (r) => `Trash emptied (${str((r as Obj).deleted)} items)`);
    }));
}
