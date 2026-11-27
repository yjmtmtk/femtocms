import { getCollectionRow } from "./collections";
import { bumpVersion, requireRole, type Ctx } from "./context";
import { FemtoError, type Issue } from "./errors";
import { newId, SLUG_RE } from "./ids";
import { buildListQuery, cursorLookup, type ListParams } from "./query";
import type { Collection, EntryRecord, FieldDef, Status } from "./types";
import { validateData, type ValidateResult } from "./validate";

interface EntryRow {
  id: string; collection_id: string; slug: string | null; status: Status; data: string;
  created_at: string; updated_at: string; published_at: string | null; deleted_at: string | null;
}

export interface EntryInput { data?: unknown; slug?: string | null; status?: Status; publishedAt?: string }
export interface EntryPatch { data?: unknown; slug?: string | null; publishedAt?: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const toRecord = (r: EntryRow): EntryRecord => ({
  id: r.id, collectionId: r.collection_id, slug: r.slug, status: r.status,
  data: JSON.parse(r.data) as Record<string, unknown>,
  createdAt: r.created_at, updatedAt: r.updated_at, publishedAt: r.published_at,
});

const entryNotFound = (collection: string, idOrSlug: string) =>
  new FemtoError("not_found", `Entry "${idOrSlug}" not found in collection "${collection}"`, {
    hint: "Call list_entries to see the existing entries.",
  });

const invalid = (issues: Issue[]) => new FemtoError("validation_failed", "Invalid input", { issues });

/** Admin-only writes: the role is checked before the collection is looked up. */
async function writableCollection(ctx: Ctx, name: string): Promise<Collection> {
  requireRole(ctx, "admin");
  return getCollectionRow(ctx, name);
}

async function singleCollection(ctx: Ctx, name: string, verb: string): Promise<Collection> {
  const c = await getCollectionRow(ctx, name);
  if (c.kind !== "single") {
    throw new FemtoError("bad_request", `Collection "${name}" is not a single collection, so ${verb} cannot be used`, {
      hint: "For a list collection, use GET /api/<name>/<idOrSlug>.",
    });
  }
  return c;
}

async function findRow(ctx: Ctx, c: Collection, idOrSlug: string | null): Promise<EntryRow | null> {
  const base = "SELECT * FROM entries WHERE collection_id = ? AND deleted_at IS NULL";
  const stmt = idOrSlug === null
    ? ctx.db.prepare(base).bind(c.id)
    : ctx.db.prepare(`${base} AND (id = ? OR slug = ?)`).bind(c.id, idOrSlug, idOrSlug);
  return stmt.first<EntryRow>();
}

async function requireRow(ctx: Ctx, c: Collection, idOrSlug: string): Promise<EntryRow> {
  const row = await findRow(ctx, c, idOrSlug);
  if (!row) throw entryNotFound(c.name, idOrSlug);
  return row;
}

// Public may read published entries of public collections; read: published of any; admin: everything.
export function canRead(ctx: Ctx, c: Collection, status: Status): boolean {
  if (ctx.role === "admin") return true;
  if (ctx.role === "public" && !c.public) return false;
  return status === "published";
}

function visible(ctx: Ctx, c: Collection, row: EntryRow, allowDraft?: boolean): boolean {
  return !!allowDraft || canRead(ctx, c, row.status);
}

/** One query for many entries (not trashed, no visibility filter; callers apply canRead). Ids go in as a JSON array so D1's bind limit doesn't matter. */
export async function getEntryRecordsByIds(ctx: Ctx, ids: string[], collectionIds: string[]): Promise<EntryRecord[]> {
  const { results } = await ctx.db
    .prepare(
      "SELECT * FROM entries WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) " +
        "AND collection_id IN (SELECT value FROM json_each(?))",
    )
    .bind(JSON.stringify(ids), JSON.stringify(collectionIds))
    .all<EntryRow>();
  return results.map(toRecord);
}

async function readEntry(ctx: Ctx, name: string, idOrSlug: string | null, opts?: { allowDraft?: boolean }): Promise<EntryRecord> {
  const c = await getCollectionRow(ctx, name);
  const label = idOrSlug ?? name;
  if (ctx.role === "public" && !c.public && !opts?.allowDraft) throw entryNotFound(name, label);
  const row = await findRow(ctx, c, idOrSlug);
  if (!row || !visible(ctx, c, row, opts?.allowDraft)) throw entryNotFound(name, label);
  return toRecord(row);
}

export function getEntryRecord(ctx: Ctx, collection: string, idOrSlug: string, opts?: { allowDraft?: boolean }): Promise<EntryRecord> {
  return readEntry(ctx, collection, idOrSlug, opts);
}

export interface ListResult { items: EntryRecord[]; total: number; limit: number; offset: number }

/** Lists entries with the same visibility rules as single reads. Returns full records (field selection is a presentation concern). */
export async function listEntryRecords(ctx: Ctx, collection: string, params: ListParams): Promise<ListResult> {
  const c = await getCollectionRow(ctx, collection);
  if (ctx.role === "public" && !c.public) {
    throw new FemtoError("not_found", `Collection "${collection}" not found`, { hint: "Call list_collections to see the existing collections." });
  }
  if (params.after !== undefined && params.before !== undefined) {
    throw new FemtoError("bad_request", "after and before cannot be used together", { hint: "Pass only one of them." });
  }
  let cursorValues: unknown[] | undefined;
  const lookup = cursorLookup(c, params, ctx.role);
  if (lookup) {
    const key = (params.after ?? params.before)!;
    const row = await ctx.db.prepare(lookup.sql).bind(c.id, key, key).first<Record<string, unknown>>();
    if (!row) {
      throw new FemtoError("bad_request", `Entry "${key}" given as ${params.after !== undefined ? "after" : "before"} was not found`, {
        hint: `Pass the id or slug of ${ctx.role === "admin" ? "an" : "a published"} entry in "${collection}".`,
      });
    }
    cursorValues = Array.from({ length: lookup.keys }, (_, i) => row[`k${i}`] ?? null);
  }
  const q = buildListQuery(c, params, ctx.role, cursorValues);
  const [page, count] = await ctx.db.batch([
    ctx.db.prepare(q.sql).bind(...q.binds),
    ctx.db.prepare(q.countSql).bind(...q.binds),
  ]);
  const rows = page.results as EntryRow[];
  return {
    items: (q.reversed ? rows.reverse() : rows).map(toRecord),
    total: (count.results[0] as { n: number }).n,
    limit: q.limit,
    offset: q.offset,
  };
}

export async function getSingle(ctx: Ctx, collection: string): Promise<EntryRecord> {
  await singleCollection(ctx, collection, "GET /api/<name>");
  return readEntry(ctx, collection, null);
}

/**
 * Reports media / referenced entries that do not exist (or are trashed, or live in the wrong collection).
 * At most two queries however many refs there are (ids travel as one JSON array): D1 caps the queries per request.
 */
export async function assertRefs(ctx: Ctx, refs: ValidateResult["refs"], _fields: FieldDef[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const at = (paths: string[] | undefined, message: string, expected: string, received: string) => {
    for (const path of paths ?? ["data"]) issues.push({ path, message, expected, received });
  };
  const [liveMedia, owners] = await Promise.all([
    refs.media.length === 0 ? [] : ctx.db
      .prepare("SELECT id FROM media WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(refs.media)).all<{ id: string }>().then((r) => r.results),
    refs.entries.length === 0 ? [] : ctx.db
      .prepare(
        "SELECT e.id AS id, e.deleted_at AS e_deleted, c.name AS cname, c.deleted_at AS c_deleted " +
          "FROM entries e JOIN collections c ON c.id = e.collection_id WHERE e.id IN (SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify([...new Set(refs.entries.map((r) => r.id))]))
      .all<{ id: string; e_deleted: string | null; cname: string; c_deleted: string | null }>().then((r) => r.results),
  ]);
  const media = new Set(liveMedia.map((r) => r.id));
  const entries = new Map(owners.map((r) => [r.id, r]));
  for (const id of refs.media) {
    if (!media.has(id)) at(refs.paths.media[id], "media not found (missing or in trash)", "existing media id", id);
  }
  for (const ref of refs.entries) {
    const row = entries.get(ref.id);
    const paths = refs.paths.entries[`${ref.collection}/${ref.id}`];
    const expected = `existing entry id in "${ref.collection}"`;
    if (!row || row.e_deleted || row.c_deleted) at(paths, "referenced entry not found (missing or in trash)", expected, ref.id);
    else if (row.cname !== ref.collection) at(paths, `referenced entry belongs to "${row.cname}"`, expected, ref.id);
  }
  return issues;
}

function parseSlug(slug: unknown): { value: string | null; issues: Issue[] } {
  if (slug === null || slug === undefined) return { value: null, issues: [] };
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return { value: null, issues: [{ path: "slug", message: "invalid slug", expected: SLUG_RE.source, received: slug }] };
  }
  return { value: slug, issues: [] };
}

function parsePublishedAt(v: unknown): { value: string | null; issues: Issue[] } {
  if (v === undefined || v === null) return { value: null, issues: [] };
  const r = validateData([{ name: "publishedAt", type: "datetime" }], { publishedAt: v }, { enforceRequired: false });
  return {
    value: (r.data.publishedAt as string | undefined) ?? null,
    issues: r.issues.map(i => ({ ...i, path: "publishedAt" })),
  };
}

// Normalized schema fields plus stored keys the schema no longer knows (kept untouched, R1).
function persistable(fields: FieldDef[], normalized: Record<string, unknown>, stored: Record<string, unknown>) {
  const names = new Set(fields.map(f => f.name));
  const kept = Object.fromEntries(Object.entries(stored).filter(([k]) => !names.has(k)));
  return { ...kept, ...normalized };
}

/** Maps a UNIQUE violation to `conflict`. For slugs it looks up the holder so the hint can say whether it is in the trash. */
async function conflictFrom(ctx: Ctx, e: unknown, c: Collection, slug: string | null, selfId: string): Promise<unknown> {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : "";
  if (!/UNIQUE constraint failed/i.test(msg)) return e;
  if (!/slug/i.test(msg)) return new FemtoError("conflict", "An entry with the same id already exists");
  const holder = await ctx.db
    .prepare("SELECT deleted_at FROM entries WHERE collection_id = ? AND slug = ? AND id != ?")
    .bind(c.id, slug, selfId).first<{ deleted_at: string | null }>();
  return new FemtoError("conflict", `slug "${slug}" is already in use in collection "${c.name}"`, {
    hint: holder?.deleted_at
      ? "That slug is used by an entry in the trash. Call restore_from_trash to bring it back, empty the trash (or delete it permanently), or use a different slug."
      : "Use a different slug.",
  });
}

async function reload(ctx: Ctx, id: string): Promise<EntryRecord> {
  const row = await ctx.db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first<EntryRow>();
  return toRecord(row!);
}

export async function createEntry(
  ctx: Ctx, collection: string, input: EntryInput, internal?: { id?: string },
): Promise<EntryRecord> {
  const c = await writableCollection(ctx, collection);
  const status: Status = input.status ?? "draft";
  if (c.kind === "single" && (await findRow(ctx, c, null))) {
    throw new FemtoError("conflict", `Single collection "${c.name}" already has an entry`, {
      hint: "For a single collection, use PUT /api/<name>.",
    });
  }
  const slug = parseSlug(input.slug);
  const pubAt = parsePublishedAt(input.publishedAt);
  const v = validateData(c.fields, input.data ?? {}, { enforceRequired: status === "published" });
  const issues = [...slug.issues, ...pubAt.issues, ...v.issues, ...(await assertRefs(ctx, v.refs, c.fields))];
  if (issues.length) throw invalid(issues);

  const now = ctx.now().toISOString();
  const id = internal?.id ?? newId("e");
  const publishedAt = pubAt.value ?? (status === "published" ? now : null);
  try {
    await ctx.db
      .prepare(
        "INSERT INTO entries (id, collection_id, slug, status, data, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, c.id, slug.value, status, JSON.stringify(v.data), now, now, publishedAt)
      .run();
  } catch (e) {
    throw await conflictFrom(ctx, e, c, slug.value, id);
  }
  await bumpVersion(ctx);
  return reload(ctx, id);
}

interface Change { data: Record<string, unknown>; status: Status; slug: string | null; publishedAt: string | null }

async function saveRow(ctx: Ctx, c: Collection, id: string, ch: Change): Promise<EntryRecord> {
  try {
    await ctx.db
      .prepare("UPDATE entries SET slug = ?, status = ?, data = ?, published_at = ?, updated_at = ? WHERE id = ?")
      .bind(ch.slug, ch.status, JSON.stringify(ch.data), ch.publishedAt, ctx.now().toISOString(), id)
      .run();
  } catch (e) {
    throw await conflictFrom(ctx, e, c, ch.slug, id);
  }
  await bumpVersion(ctx);
  return reload(ctx, id);
}

const storedData = (row: EntryRow) => JSON.parse(row.data) as Record<string, unknown>;

export async function updateEntry(ctx: Ctx, collection: string, idOrSlug: string, patch: EntryPatch): Promise<EntryRecord> {
  const c = await writableCollection(ctx, collection);
  const row = await requireRow(ctx, c, idOrSlug);
  const stored = storedData(row);

  const slug = patch.slug === undefined ? { value: row.slug, issues: [] } : parseSlug(patch.slug);
  const pubAt = patch.publishedAt === undefined ? { value: row.published_at, issues: [] } : parsePublishedAt(patch.publishedAt);
  const issues: Issue[] = [...slug.issues, ...pubAt.issues];

  // (a) the incoming patch alone: unknown keys and types. Refs are only checked for what is being written.
  let patchData: Record<string, unknown> = {};
  let patchRefs: ValidateResult["refs"] | undefined;
  if (patch.data !== undefined) {
    const p = validateData(c.fields, patch.data, { enforceRequired: false, applyDefaults: false });
    issues.push(...p.issues);
    patchRefs = p.refs;
    if (isObject(patch.data)) patchData = patch.data;
  }
  if (patchRefs) issues.push(...(await assertRefs(ctx, patchRefs, c.fields)));
  if (issues.length) throw invalid(issues);

  // (b) merged over stored, schema fields only. Defaults apply on create only, so a field cleared
  // earlier (null, R8) stays absent; raw patch values are merged so the patch's own defaults don't leak in.
  const merged = validateData(c.fields, { ...stored, ...patchData }, {
    enforceRequired: row.status === "published", ignoreUnknown: true, applyDefaults: false,
  });
  if (merged.issues.length) throw invalid(merged.issues);

  return saveRow(ctx, c, row.id, {
    data: persistable(c.fields, merged.data, stored), status: row.status, slug: slug.value, publishedAt: pubAt.value,
  });
}

export async function publishEntry(ctx: Ctx, collection: string, idOrSlug: string): Promise<EntryRecord> {
  const c = await writableCollection(ctx, collection);
  const row = await requireRow(ctx, c, idOrSlug);
  const stored = storedData(row);
  const v = validateData(c.fields, stored, { enforceRequired: true, ignoreUnknown: true, applyDefaults: false });
  const issues = [...v.issues, ...(await assertRefs(ctx, v.refs, c.fields))];
  if (issues.length) throw invalid(issues);
  return saveRow(ctx, c, row.id, {
    data: persistable(c.fields, v.data, stored), status: "published", slug: row.slug,
    publishedAt: row.published_at ?? ctx.now().toISOString(),
  });
}

export async function unpublishEntry(ctx: Ctx, collection: string, idOrSlug: string): Promise<EntryRecord> {
  const c = await writableCollection(ctx, collection);
  const row = await requireRow(ctx, c, idOrSlug);
  return saveRow(ctx, c, row.id, { data: storedData(row), status: "draft", slug: row.slug, publishedAt: row.published_at });
}

export async function putSingle(
  ctx: Ctx, collection: string, input: { data: unknown; status?: Status },
): Promise<EntryRecord> {
  requireRole(ctx, "admin");
  const c = await singleCollection(ctx, collection, "PUT /api/<name>");
  const row = await findRow(ctx, c, null);
  if (!row) return createEntry(ctx, collection, { data: input.data, status: input.status });

  const status = input.status ?? row.status;
  const v = validateData(c.fields, input.data, { enforceRequired: status === "published", applyDefaults: false });
  const issues = [...v.issues, ...(await assertRefs(ctx, v.refs, c.fields))];
  if (issues.length) throw invalid(issues);
  return saveRow(ctx, c, row.id, {
    data: persistable(c.fields, v.data, storedData(row)), status, slug: row.slug,
    publishedAt: row.published_at ?? (status === "published" ? ctx.now().toISOString() : null),
  });
}
