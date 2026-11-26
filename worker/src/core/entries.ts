import { getCollectionRow } from "./collections";
import { bumpVersion, requireRole, type Ctx } from "./context";
import { FemtoError, type Issue } from "./errors";
import { newId, SLUG_RE } from "./ids";
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
  new FemtoError("not_found", `エントリ "${idOrSlug}" がコレクション "${collection}" に見つかりません`, {
    hint: "list_entries で一覧を確認してください",
  });

const invalid = (issues: Issue[]) => new FemtoError("validation_failed", "入力が不正です", { issues });

/** Admin-only writes: the role is checked before the collection is looked up. */
async function writableCollection(ctx: Ctx, name: string): Promise<Collection> {
  requireRole(ctx, "admin");
  return getCollectionRow(ctx, name);
}

async function singleCollection(ctx: Ctx, name: string, verb: string): Promise<Collection> {
  const c = await getCollectionRow(ctx, name);
  if (c.kind !== "single") {
    throw new FemtoError("bad_request", `コレクション "${name}" は single ではないため ${verb} は使えません`, {
      hint: "list コレクションは GET /api/<name>/<idOrSlug> を使ってください",
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
function visible(ctx: Ctx, c: Collection, row: EntryRow, allowDraft?: boolean): boolean {
  if (allowDraft || ctx.role === "admin") return true;
  if (ctx.role === "public" && !c.public) return false;
  return row.status === "published";
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

export async function getSingle(ctx: Ctx, collection: string): Promise<EntryRecord> {
  await singleCollection(ctx, collection, "GET /api/<name>");
  return readEntry(ctx, collection, null);
}

/** Reports media / referenced entries that do not exist (or are trashed, or live in the wrong collection). */
export async function assertRefs(ctx: Ctx, refs: ValidateResult["refs"], _fields: FieldDef[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const at = (paths: string[] | undefined, message: string, expected: string, received: string) => {
    for (const path of paths ?? ["data"]) issues.push({ path, message, expected, received });
  };
  for (const id of refs.media) {
    const found = await ctx.db.prepare("SELECT 1 AS x FROM media WHERE id = ? AND deleted_at IS NULL").bind(id).first();
    if (!found) at(refs.paths.media[id], "media not found (missing or in trash)", "existing media id", id);
  }
  for (const ref of refs.entries) {
    const row = await ctx.db
      .prepare(
        "SELECT e.deleted_at AS e_deleted, c.name AS cname, c.deleted_at AS c_deleted " +
          "FROM entries e JOIN collections c ON c.id = e.collection_id WHERE e.id = ?",
      )
      .bind(ref.id).first<{ e_deleted: string | null; cname: string; c_deleted: string | null }>();
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

function conflictFrom(e: unknown, collection: string): unknown {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : "";
  if (!/UNIQUE constraint failed/i.test(msg)) return e;
  if (/slug/i.test(msg)) {
    return new FemtoError("conflict", `slug は既に使われています (コレクション "${collection}")`, {
      hint: "別の slug を指定してください。ゴミ箱にあるエントリが使っている場合は、先にゴミ箱から削除してください",
    });
  }
  return new FemtoError("conflict", "同じ id のエントリが既に存在します");
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
    throw new FemtoError("conflict", `single コレクション "${c.name}" には既にエントリがあります`, {
      hint: "single コレクションは PUT /api/<name> を使う",
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
    throw conflictFrom(e, c.name);
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
    throw conflictFrom(e, c.name);
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
    const p = validateData(c.fields, patch.data, { enforceRequired: false });
    issues.push(...p.issues);
    patchRefs = p.refs;
    if (isObject(patch.data)) patchData = patch.data;
  }
  if (patchRefs) issues.push(...(await assertRefs(ctx, patchRefs, c.fields)));
  if (issues.length) throw invalid(issues);

  // (b) merged over stored, schema fields only. Raw patch values are merged so absent keys never pick up defaults.
  const merged = validateData(c.fields, { ...stored, ...patchData }, {
    enforceRequired: row.status === "published", ignoreUnknown: true,
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
  const v = validateData(c.fields, stored, { enforceRequired: true, ignoreUnknown: true });
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
  const v = validateData(c.fields, input.data, { enforceRequired: status === "published" });
  const issues = [...v.issues, ...(await assertRefs(ctx, v.refs, c.fields))];
  if (issues.length) throw invalid(issues);
  return saveRow(ctx, c, row.id, {
    data: persistable(c.fields, v.data, storedData(row)), status, slug: row.slug,
    publishedAt: row.published_at ?? (status === "published" ? ctx.now().toISOString() : null),
  });
}
