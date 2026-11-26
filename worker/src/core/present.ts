import { getCollectionRow } from "./collections";
import type { Ctx } from "./context";
import { canRead, getEntryRecordsByIds } from "./entries";
import { renderMarkdown } from "./markdown";
import type { Collection, EntryRecord, FieldDef, MediaRecord, Status } from "./types";

export interface ApiMedia {
  id: string; url: string; filename: string; mimeType: string; size: number;
  width: number | null; height: number | null; alt: string; createdAt: string;
}

export interface ApiEntry {
  id: string; slug: string | null; status: Status; createdAt: string; updatedAt: string; publishedAt: string | null;
  data: Record<string, unknown>; html: Record<string, string>;
}

export interface PresentOpts { fields?: string[]; expand?: string[] }

interface MediaRow {
  id: string; filename: string; mime_type: string; size: number; width: number | null; height: number | null;
  alt: string; created_at: string;
}

// toWellFormed: encodeURIComponent throws on a lone surrogate, and a stored name must never turn a read into a 500.
export const mediaUrl = (origin: string, m: { id: string; filename: string }): string =>
  `${origin}/media/${m.id}/${encodeURIComponent(m.filename.toWellFormed())}`;

export function presentMedia(ctx: Ctx, m: MediaRecord): ApiMedia {
  return {
    id: m.id, url: mediaUrl(ctx.origin, m), filename: m.filename, mimeType: m.mimeType, size: m.size,
    width: m.width, height: m.height, alt: m.alt, createdAt: m.createdAt,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type MediaMap = Map<string, ApiMedia>;
/** Live entry id (not trashed, collection not trashed) -> its collection name. */
type OwnerMap = Map<string, string>;
interface Lookups { media: MediaMap; owners: OwnerMap }

// Only well-formed ids are looked up; anything else stored in an image / reference field is legacy data and passes through.
const MEDIA_ID_RE = /^m_[0-9a-z]{12}$/;
const isMediaId = (v: unknown): v is string => typeof v === "string" && MEDIA_ID_RE.test(v);
const ENTRY_ID_RE = /^e_[0-9a-z]{12}$/;
const isEntryId = (v: unknown): v is string => typeof v === "string" && ENTRY_ID_RE.test(v);

// Own properties only, so a field named "constructor" or "toString" never picks up Object.prototype.
const own = (data: Record<string, unknown>, name: string): unknown => (Object.hasOwn(data, name) ? data[name] : undefined);

// Walks the stored values of `fields` the same way shapeData does and collects image ids (lists included).
function collectMediaIds(fields: FieldDef[], data: Record<string, unknown>, into: Set<string>): void {
  for (const f of fields) {
    const v = own(data, f.name);
    if (f.type === "image") {
      for (const x of Array.isArray(v) ? v : [v]) if (isMediaId(x)) into.add(x);
    } else if (f.type === "list" && Array.isArray(v)) {
      for (const item of v) if (isObject(item)) collectMediaIds(f.fields ?? [], item, into);
    }
  }
}

// Collects the entry ids held by the reference fields among `fields` (lists included), except the fields named in `skip`.
function collectEntryIds(fields: FieldDef[], data: Record<string, unknown>, into: Set<string>, skip?: Set<string>): void {
  for (const f of fields) {
    if (skip?.has(f.name)) continue;
    const v = own(data, f.name);
    if (f.type === "reference") {
      for (const x of Array.isArray(v) ? v : [v]) if (isEntryId(x)) into.add(x);
    } else if (f.type === "list" && Array.isArray(v)) {
      for (const item of v) if (isObject(item)) collectEntryIds(f.fields ?? [], item, into);
    }
  }
}

/** A reference id is shown only while its target is live and in the field's collection (R17). */
const liveRef = (f: FieldDef, id: string, owners: OwnerMap) => owners.get(id) === f.collection;

// v1: inside lists, images become ApiMedia too, references stay id strings (expand is top-level only) and markdown stays a raw string (no html).
// Images and references whose target is missing / trashed (or, for references, in another collection) read as null; in a
// `multiple` array they are removed. Non-id legacy values pass through.
function shapeData(fields: FieldDef[], data: Record<string, unknown>, lk: Lookups): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!Object.hasOwn(data, f.name)) continue;
    const v = data[f.name];
    if (f.type === "image" && f.multiple === true && Array.isArray(v)) {
      out[f.name] = v.flatMap((x) => (isMediaId(x) ? (lk.media.get(x) ?? []) : [x]));
    } else if (f.type === "image" && isMediaId(v)) out[f.name] = lk.media.get(v) ?? null;
    else if (f.type === "reference" && f.multiple === true && Array.isArray(v)) {
      out[f.name] = v.filter((x) => !isEntryId(x) || liveRef(f, x, lk.owners));
    } else if (f.type === "reference" && isEntryId(v)) out[f.name] = liveRef(f, v, lk.owners) ? v : null;
    else if (f.type === "list" && Array.isArray(v)) {
      out[f.name] = v.map((item) => (isObject(item) ? shapeData(f.fields ?? [], item, lk) : item));
    } else out[f.name] = v;
  }
  return out;
}

function shapeEntry(
  collection: Collection, r: EntryRecord, lk: Lookups, fieldFilter: Set<string> | undefined,
  expanded: Map<string, ApiEntry | null>,
): ApiEntry {
  const shown = collection.fields.filter((f) => !fieldFilter || fieldFilter.has(f.name));
  const data = shapeData(shown, r.data, lk);
  const html: Record<string, string> = {};
  for (const f of shown) {
    const v = own(r.data, f.name);
    if (f.type === "markdown" && typeof v === "string") html[f.name] = renderMarkdown(v);
    if (f.type === "reference" && typeof v === "string" && expanded.has(`${f.name}\0${v}`)) {
      data[f.name] = expanded.get(`${f.name}\0${v}`);
    } else if (f.type === "reference" && f.multiple === true && Array.isArray(v)) {
      // Only expanded fields have entries in `expanded`; unreadable / missing / trashed elements are removed from the array.
      const key = (x: unknown) => `${f.name}\0${x}`;
      if (v.some((x) => typeof x === "string" && expanded.has(key(x)))) {
        data[f.name] = v.flatMap((x) => (typeof x === "string" && expanded.has(key(x)) ? (expanded.get(key(x)) ?? []) : [x]));
      }
    }
  }
  return {
    id: r.id, slug: r.slug, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, publishedAt: r.publishedAt,
    data, html,
  };
}

/** One query for every reference target the output shows (none when there is nothing to check). */
async function loadOwners(ctx: Ctx, ids: Set<string>): Promise<OwnerMap> {
  const map: OwnerMap = new Map();
  if (ids.size === 0) return map;
  const { results } = await ctx.db
    .prepare(
      "SELECT e.id AS id, c.name AS cname FROM entries e JOIN collections c ON c.id = e.collection_id " +
        "WHERE e.deleted_at IS NULL AND c.deleted_at IS NULL AND e.id IN (SELECT value FROM json_each(?))",
    )
    .bind(JSON.stringify([...ids]))
    .all<{ id: string; cname: string }>();
  for (const r of results) map.set(r.id, r.cname);
  return map;
}

async function loadMedia(ctx: Ctx, ids: Set<string>): Promise<MediaMap> {
  const map: MediaMap = new Map();
  if (ids.size === 0) return map;
  const { results } = await ctx.db
    .prepare("SELECT * FROM media WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...ids]))
    .all<MediaRow>();
  for (const r of results) {
    map.set(r.id, presentMedia(ctx, {
      id: r.id, filename: r.filename, mimeType: r.mime_type, size: r.size, width: r.width, height: r.height,
      alt: r.alt, createdAt: r.created_at,
    }));
  }
  return map;
}

/** Referenced entries keyed by `${fieldName}\0${id}`; null when missing, trashed, in another collection or not visible to the caller. */
async function loadExpanded(
  ctx: Ctx, collection: Collection, records: EntryRecord[], expand: string[],
): Promise<{ refs: Map<string, { collection: Collection; record: EntryRecord } | null> }> {
  const wanted = collection.fields.filter((f) => f.type === "reference" && f.collection && expand.includes(f.name));
  const keys = new Map<string, { field: FieldDef; id: string }>();
  for (const r of records) {
    for (const f of wanted) {
      const v = own(r.data, f.name);
      for (const id of Array.isArray(v) ? v : [v]) if (typeof id === "string") keys.set(`${f.name}\0${id}`, { field: f, id });
    }
  }
  const refs = new Map<string, { collection: Collection; record: EntryRecord } | null>();
  if (keys.size === 0) return { refs };

  const targets = new Map<string, Collection | null>();
  for (const name of new Set(wanted.map((f) => f.collection!))) {
    targets.set(name, await getCollectionRow(ctx, name).catch(() => null));
  }
  const live = [...targets.values()].filter((c): c is Collection => c !== null);
  const rows = live.length
    ? await getEntryRecordsByIds(ctx, [...new Set([...keys.values()].map((k) => k.id))], live.map((c) => c.id))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [key, { field, id }] of keys) {
    const c = targets.get(field.collection!);
    const r = byId.get(id);
    refs.set(key, c && r && r.collectionId === c.id && canRead(ctx, c, r.status) ? { collection: c, record: r } : null);
  }
  return { refs };
}

export async function presentEntries(
  ctx: Ctx, collection: Collection, records: EntryRecord[], opts: PresentOpts,
): Promise<ApiEntry[]> {
  const fieldFilter = opts.fields ? new Set(opts.fields) : undefined;
  const { refs } = await loadExpanded(ctx, collection, records, opts.expand ?? []);

  // A single media query and a single reference-existence query cover the records and any expanded references.
  // Expanded fields are resolved by loadExpanded itself, so their ids need no existence check.
  const mediaIds = new Set<string>();
  const entryIds = new Set<string>();
  const visibleFields = collection.fields.filter((f) => !fieldFilter || fieldFilter.has(f.name));
  const expandedFields = new Set(
    collection.fields.filter((f) => f.type === "reference" && f.collection && (opts.expand ?? []).includes(f.name)).map((f) => f.name),
  );
  for (const r of records) {
    collectMediaIds(visibleFields, r.data, mediaIds);
    collectEntryIds(visibleFields, r.data, entryIds, expandedFields);
  }
  for (const ref of refs.values()) {
    if (!ref) continue;
    collectMediaIds(ref.collection.fields, ref.record.data, mediaIds);
    collectEntryIds(ref.collection.fields, ref.record.data, entryIds);
  }
  const lk: Lookups = { media: await loadMedia(ctx, mediaIds), owners: await loadOwners(ctx, entryIds) };

  // Expanded entries are shaped without further expansion.
  const expanded = new Map<string, ApiEntry | null>();
  for (const [key, ref] of refs) {
    expanded.set(key, ref ? shapeEntry(ref.collection, ref.record, lk, undefined, new Map()) : null);
  }
  return records.map((r) => shapeEntry(collection, r, lk, fieldFilter, expanded));
}

export async function presentEntry(
  ctx: Ctx, collection: Collection, record: EntryRecord, opts: PresentOpts,
): Promise<ApiEntry> {
  return (await presentEntries(ctx, collection, [record], opts))[0];
}
