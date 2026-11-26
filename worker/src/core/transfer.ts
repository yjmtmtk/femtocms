import { parseCollectionInput } from "./collection-def";
import { referencedCollections } from "./collections";
import { bumpVersion, requireConfirm, requireRole, type Ctx } from "./context";
import { FemtoError, type Issue } from "./errors";
import { newId, SLUG_RE } from "./ids";
import { fetchRemoteMedia, mimeFromFilename, normalizeMime, putMediaObject, r2Key, sanitizeFilename } from "./media";
import { mediaUrl } from "./present";
import type { CollectionInput, EntryRecord, FieldDef, MediaRecord, Status } from "./types";
import { validateData, type ValidateResult } from "./validate";

export interface ExportData {
  format: "femtocms-export";
  version: 1;
  exportedAt: string;
  site: string;
  collections: CollectionInput[];
  entries: (Omit<EntryRecord, "collectionId"> & { collection: string })[];
  media: (MediaRecord & { url: string })[];
}

const FORMAT = "femtocms-export";
const ENTRY_ID_RE = /^e_[0-9a-z]{12}$/;
const MEDIA_ID_RE = /^m_[0-9a-z]{12}$/;
// D1 caps a bound string at 2MB; rows are sent as JSON arrays (one statement per table chunk) and kept well below that.
const CHUNK_BYTES = 500_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const invalid = (issues: Issue[], message = "入力が不正です") => new FemtoError("validation_failed", message, { issues });

/** `collections[0]` + `fields[1].options` -> `collections[0].fields[1].options`. */
const join = (prefix: string, path: string) =>
  path === "" ? prefix : path.startsWith("[") ? prefix + path : `${prefix}.${path}`;

// ---------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------

/** What an export may point at: media ids and entry ids (with their collection) that are in the same export. */
interface Targets { media: Set<string>; entries: Map<string, string> }

/**
 * Cleans stored entry data so the export imports strictly (R10, R11). Only keys the schema defines survive (stale keys
 * kept by R1 go), also inside `list` items. A value invalid for its field's current type is dropped, and so is an
 * image / reference whose target is not part of the export (trashed or deleted: reads show null for it anyway).
 */
function exportableData(fields: FieldDef[], data: Record<string, unknown>, targets: Targets): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = data[f.name];
    if (v === undefined || v === null) continue;
    if (f.type === "list") {
      if (Array.isArray(v)) {
        out[f.name] = v.filter(isObject).map((item) => exportableData(f.fields ?? [], item, targets));
      }
      continue;
    }
    if (f.multiple === true && (f.type === "image" || f.type === "reference")) {
      // Keep the array; drop only the dangling / invalid elements (possibly leaving []).
      if (!Array.isArray(v)) continue;
      const one: FieldDef = { ...f, multiple: false };
      out[f.name] = v.flatMap((x) => {
        const kept = exportableValue(one, x, targets);
        return kept === undefined ? [] : [kept];
      });
      continue;
    }
    const kept = exportableValue(f, v, targets);
    if (kept !== undefined) out[f.name] = kept;
  }
  return out;
}

/** The normalized value when it is valid for `f` and points only at things in the export; otherwise undefined. */
function exportableValue(f: FieldDef, v: unknown, targets: Targets): unknown {
  const r = validateData([f], { [f.name]: v }, { enforceRequired: false, ignoreUnknown: true, applyDefaults: false });
  if (r.issues.length) return undefined;
  const dangling =
    r.refs.media.some((id) => !targets.media.has(id)) ||
    r.refs.entries.some((e) => targets.entries.get(e.id) !== e.collection);
  return dangling ? undefined : r.data[f.name];
}

/** Everything except the trash, `settings` and `api_keys`. Entry data is the stored value (media / references stay ids) cleaned by exportableData so it always re-imports. */
export async function exportData(ctx: Ctx): Promise<ExportData> {
  requireRole(ctx, "admin");
  const [collections, entries, media] = await ctx.db.batch([
    ctx.db.prepare("SELECT * FROM collections WHERE deleted_at IS NULL ORDER BY name"),
    ctx.db.prepare(
      "SELECT e.*, c.name AS cname FROM entries e JOIN collections c ON c.id = e.collection_id " +
        "WHERE e.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY c.name, e.created_at, e.id",
    ),
    ctx.db.prepare("SELECT * FROM media WHERE deleted_at IS NULL ORDER BY created_at, id"),
  ]);
  type Row = Record<string, string | number | null>;
  const targets: Targets = {
    media: new Set((media.results as Row[]).map((r) => r.id as string)),
    entries: new Map((entries.results as Row[]).map((r) => [r.id as string, r.cname as string])),
  };
  const schemas = new Map((collections.results as Row[]).map((r) => [r.name as string, JSON.parse(r.fields as string) as FieldDef[]]));
  return {
    format: FORMAT, version: 1, exportedAt: ctx.now().toISOString(), site: ctx.siteName,
    collections: (collections.results as Row[]).map((r): CollectionInput => ({
      name: r.name as string,
      ...(r.label !== null ? { label: r.label as string } : {}),
      ...(r.description !== null ? { description: r.description as string } : {}),
      kind: r.kind as "list" | "single", public: r.public === 1, fields: JSON.parse(r.fields as string) as FieldDef[],
    })),
    entries: (entries.results as Row[]).map((r) => ({
      id: r.id as string, collection: r.cname as string, slug: r.slug as string | null, status: r.status as Status,
      data: exportableData(schemas.get(r.cname as string) ?? [], JSON.parse(r.data as string) as Record<string, unknown>, targets),
      createdAt: r.created_at as string, updatedAt: r.updated_at as string, publishedAt: r.published_at as string | null,
    })),
    media: (media.results as Row[]).map((r) => {
      const m: MediaRecord = {
        id: r.id as string, filename: r.filename as string, mimeType: r.mime_type as string, size: r.size as number,
        width: r.width as number | null, height: r.height as number | null, alt: r.alt as string, createdAt: r.created_at as string,
      };
      return { ...m, url: mediaUrl(ctx.origin, m) };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------------------------

/**
 * Same effect as trashCollection on every live collection plus trashMedia on every live media row: entries
 * go with their collection (trashed_with), entries already in the trash keep their own deleted_at.
 * Entries first, while their collections are still live.
 */
function trashAllStatements(ctx: Ctx): D1PreparedStatement[] {
  const now = ctx.now().toISOString();
  return [
    ctx.db
      .prepare(
        "UPDATE entries SET deleted_at = ?, trashed_with = collection_id WHERE deleted_at IS NULL " +
          "AND collection_id IN (SELECT id FROM collections WHERE deleted_at IS NULL)",
      )
      .bind(now),
    ctx.db.prepare("UPDATE collections SET deleted_at = ? WHERE deleted_at IS NULL").bind(now),
    ctx.db.prepare("UPDATE media SET deleted_at = ? WHERE deleted_at IS NULL").bind(now),
  ];
}

/** Moves every live collection (with its entries) and media to the trash. `trashed` counts what listTrash gains. */
export async function resetSite(ctx: Ctx, confirm: string | undefined): Promise<{ trashed: number }> {
  requireRole(ctx, "admin");
  requireConfirm(ctx, confirm);
  const [collections, media] = await ctx.db.batch([
    ctx.db.prepare("SELECT COUNT(*) AS n FROM collections WHERE deleted_at IS NULL"),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE deleted_at IS NULL"),
    ...trashAllStatements(ctx),
  ]);
  await bumpVersion(ctx);
  return { trashed: (collections.results[0] as { n: number }).n + (media.results[0] as { n: number }).n };
}

// ---------------------------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------------------------

interface DbCollection { id: string; name: string; kind: "list" | "single"; fields: string; deleted_at: string | null }
interface PlannedCollection { index: number; def: CollectionInput; id: string }
interface PlannedEntry {
  id: string; collectionId: string; slug: string | null; status: Status; data: Record<string, unknown>;
  createdAt: string; updatedAt: string; publishedAt: string | null;
}
/** `preexisting`: a media row (trash included) or an R2 object already used this id before the import. */
interface PlannedMedia { index: number; record: MediaRecord; url?: string; inR2: boolean; preexisting: boolean }
interface Plan { collections: PlannedCollection[]; entries: PlannedEntry[]; media: PlannedMedia[]; existingCollectionIds: string[] }

const isTimestamp = (v: unknown): v is string => typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Rows by id from a table, as one query (ids travel as a JSON array, so D1's bind-parameter limit does not matter). */
async function select<T>(ctx: Ctx, sql: string, values: unknown[]): Promise<T[]> {
  if (values.length === 0) return [];
  return (await ctx.db.prepare(sql).bind(JSON.stringify(values)).all<T>()).results;
}

/**
 * Sizes of the R2 objects `media/<id>` for the given ids. Instead of one `head` per media (a subrequest each, which a big
 * import would run out of), it pages through the `media/` prefix: one `list` call per 1000 stored objects, stopping as
 * soon as every id has been seen. The cost grows with the bucket, not with the import, and stays small for a CMS-sized bucket.
 */
async function r2Sizes(ctx: Ctx, ids: Set<string>): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (ids.size === 0) return sizes;
  const prefix = r2Key("");
  let cursor: string | undefined;
  do {
    const page = await ctx.bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) {
      const id = o.key.slice(prefix.length);
      if (ids.has(id)) sizes.set(id, o.size);
    }
    cursor = page.truncated && sizes.size < ids.size ? page.cursor : undefined;
  } while (cursor);
  return sizes;
}

/** Checks the whole export against the current DB and returns what to write. Throws validation_failed listing every problem; writes nothing. */
async function planImport(ctx: Ctx, data: unknown, replace: boolean): Promise<Plan> {
  const issues: Issue[] = [];
  const push = (path: string, message: string, expected?: string, received?: unknown) =>
    issues.push({ path, message, ...(expected !== undefined ? { expected } : {}), ...(received !== undefined ? { received } : {}) });

  if (!isObject(data)) throw invalid([{ path: "data", message: "object required", expected: "femtocms export object", received: data }]);
  if (data.format !== FORMAT) push("format", `format は "${FORMAT}" である必要があります`, FORMAT, data.format);
  if (data.version !== 1) push("version", "対応しているのは version 1 のみです", "1", data.version);
  for (const key of ["collections", "entries", "media"] as const) {
    if (!Array.isArray(data[key])) push(key, `${key} は配列である必要があります`, "array", data[key]);
  }
  if (issues.length) throw invalid(issues);
  const rawCollections = data.collections as unknown[];
  const rawEntries = data.entries as unknown[];
  const rawMedia = data.media as unknown[];

  // What already exists. In replace mode all of it is about to be trashed, so nothing counts as "existing" except for slug / id clashes.
  const dbCollections = (await ctx.db.prepare("SELECT id, name, kind, fields, deleted_at FROM collections").all<DbCollection>()).results;
  const dbByName = new Map(dbCollections.map((c) => [c.name, c]));
  const live = new Map(replace ? [] : dbCollections.filter((c) => !c.deleted_at).map((c) => [c.name, c]));

  // --- collections
  const planned: PlannedCollection[] = [];
  const defs = new Map<string, PlannedCollection>();
  rawCollections.forEach((raw, i) => {
    let def: CollectionInput;
    try {
      def = parseCollectionInput(raw, "create");
    } catch (e) {
      if (!(e instanceof FemtoError) || !e.issues) throw e;
      issues.push(...e.issues.map((x) => ({ ...x, path: join(`collections[${i}]`, x.path) })));
      return;
    }
    if (defs.has(def.name)) {
      push(`collections[${i}].name`, `コレクション名 "${def.name}" が重複しています`);
      return;
    }
    const p = { index: i, def, id: dbByName.get(def.name)?.id ?? newId("c") };
    defs.set(def.name, p);
    planned.push(p);
  });
  for (const { index, def } of planned) {
    for (const ref of referencedCollections(def.fields)) {
      if (!defs.has(ref.collection) && !live.has(ref.collection)) {
        push(`collections[${index}].${ref.path}`, `参照先コレクション "${ref.collection}" が存在しません`);
      }
    }
  }
  const collectionOf = (name: string): { id: string; kind: string; fields: FieldDef[] } | undefined => {
    const d = defs.get(name);
    if (d) return { id: d.id, kind: d.def.kind ?? "list", fields: d.def.fields };
    const c = live.get(name);
    return c && { id: c.id, kind: c.kind, fields: JSON.parse(c.fields) as FieldDef[] };
  };

  // --- media (shape only; files are fetched after everything else has passed)
  const mediaIds = new Set<string>();
  const media: PlannedMedia[] = [];
  rawMedia.forEach((raw, i) => {
    const p = `media[${i}]`;
    if (!isObject(raw)) return push(p, "object required", "object", raw);
    const before = issues.length;
    if (typeof raw.id !== "string" || !MEDIA_ID_RE.test(raw.id)) push(`${p}.id`, "不正なメディア id です", "m_ + 12 chars of [0-9a-z]", raw.id);
    else if (mediaIds.has(raw.id)) push(`${p}.id`, `メディア id "${raw.id}" が重複しています`);
    else mediaIds.add(raw.id);
    if (typeof raw.filename !== "string" || raw.filename === "") push(`${p}.filename`, "filename が必要です", "string", raw.filename);
    if (typeof raw.mimeType !== "string") push(`${p}.mimeType`, "mimeType が必要です", "string", raw.mimeType);
    for (const k of ["width", "height"] as const) {
      if (raw[k] !== null && raw[k] !== undefined && !isCount(raw[k])) push(`${p}.${k}`, `${k} は 0 以上の整数か null です`, "integer | null", raw[k]);
    }
    if (typeof raw.alt !== "string") push(`${p}.alt`, "alt は文字列です", "string", raw.alt);
    if (!isTimestamp(raw.createdAt)) push(`${p}.createdAt`, "ISO 8601 の日時が必要です", "ISO 8601 datetime string", raw.createdAt);
    let url: string | undefined;
    if (raw.url !== undefined) {
      if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) {
        push(`${p}.url`, "url は http:// または https:// の URL です", "http(s) URL", raw.url);
      } else {
        url = raw.url;
      }
    }
    if (issues.length > before) return;
    // Same clean-up as every upload path. `size` of the export is ignored: it comes from the bytes (fetched) or from R2 (head).
    const filename = sanitizeFilename(raw.filename as string);
    media.push({
      index: i, url, inR2: false, preexisting: false,
      record: {
        id: raw.id as string, filename, mimeType: normalizeMime(raw.mimeType as string) ?? mimeFromFilename(filename), size: 0,
        width: (raw.width as number | null | undefined) ?? null, height: (raw.height as number | null | undefined) ?? null,
        alt: raw.alt as string, createdAt: raw.createdAt as string,
      },
    });
  });

  // --- entries
  interface Pending { index: number; refs: ValidateResult["refs"] }
  const pending: Pending[] = [];
  const entries: (PlannedEntry & { index: number; collection: string })[] = [];
  const entryIds = new Map<string, string>(); // id -> collection name
  const slugs = new Set<string>();
  rawEntries.forEach((raw, i) => {
    const p = `entries[${i}]`;
    if (!isObject(raw)) return push(p, "object required", "object", raw);
    const before = issues.length;
    const id = raw.id;
    if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) push(`${p}.id`, "不正なエントリ id です", "e_ + 12 chars of [0-9a-z]", id);
    else if (entryIds.has(id)) push(`${p}.id`, `エントリ id "${id}" が重複しています`);
    const c = typeof raw.collection === "string" ? collectionOf(raw.collection) : undefined;
    if (!c) push(`${p}.collection`, `コレクション "${String(raw.collection)}" が取り込みにも既存にもありません`, "collection name", raw.collection);
    const slug = raw.slug ?? null;
    if (slug !== null && (typeof slug !== "string" || !SLUG_RE.test(slug))) {
      push(`${p}.slug`, "不正な slug です", SLUG_RE.source, slug);
    } else if (slug !== null && c) {
      const key = `${c.id}/${slug}`;
      if (slugs.has(key)) push(`${p}.slug`, `slug "${slug}" が取り込み内で重複しています`);
      slugs.add(key);
    }
    const status = raw.status;
    if (status !== "draft" && status !== "published") push(`${p}.status`, 'status は "draft" か "published" です', "draft | published", status);
    for (const k of ["createdAt", "updatedAt"] as const) {
      if (!isTimestamp(raw[k])) push(`${p}.${k}`, "ISO 8601 の日時が必要です", "ISO 8601 datetime string", raw[k]);
    }
    if (raw.publishedAt !== null && raw.publishedAt !== undefined && !isTimestamp(raw.publishedAt)) {
      push(`${p}.publishedAt`, "ISO 8601 の日時か null です", "ISO 8601 datetime string | null", raw.publishedAt);
    }
    let normalized: Record<string, unknown> = {};
    if (c && (status === "draft" || status === "published")) {
      const v = validateData(c.fields, raw.data, { enforceRequired: false, ignoreUnknown: false, applyDefaults: false });
      issues.push(...v.issues.map((x) => ({ ...x, path: join(p, x.path) })));
      normalized = v.data;
      pending.push({ index: i, refs: v.refs });
    }
    if (typeof id === "string") entryIds.set(id, String(raw.collection));
    if (issues.length > before || !c) return;
    entries.push({
      index: i, collection: raw.collection as string, id: id as string, collectionId: c.id, slug: slug as string | null,
      status: status as Status, data: normalized, createdAt: raw.createdAt as string, updatedAt: raw.updatedAt as string,
      publishedAt: (raw.publishedAt as string | null | undefined) ?? null,
    });
  });

  // --- references: imported ones, else (merge only) live ones in the DB
  const dbMedia = new Set(replace ? [] : (await select<{ id: string }>(
    ctx, "SELECT id FROM media WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))",
    [...new Set(pending.flatMap((p) => p.refs.media))],
  )).map((r) => r.id));
  const dbEntries = new Map(replace ? [] : (await select<{ id: string; cname: string }>(
    ctx,
    "SELECT e.id, c.name AS cname FROM entries e JOIN collections c ON c.id = e.collection_id " +
      "WHERE e.deleted_at IS NULL AND c.deleted_at IS NULL AND e.id IN (SELECT value FROM json_each(?))",
    [...new Set(pending.flatMap((p) => p.refs.entries.map((e) => e.id)))],
  )).map((r) => [r.id, r.cname]));
  for (const { index, refs } of pending) {
    const at = (paths: string[] | undefined, message: string, expected: string, received: string) => {
      for (const path of paths ?? ["data"]) push(join(`entries[${index}]`, path), message, expected, received);
    };
    for (const id of refs.media) {
      if (!mediaIds.has(id) && !dbMedia.has(id)) at(refs.paths.media[id], "media not found (not in the import, and missing or in trash)", "media id from the import or an existing one", id);
    }
    for (const ref of refs.entries) {
      const owner = entryIds.get(ref.id) ?? dbEntries.get(ref.id);
      const paths = refs.paths.entries[`${ref.collection}/${ref.id}`];
      const expected = `entry id in "${ref.collection}" from the import or an existing one`;
      if (owner === undefined) at(paths, "referenced entry not found (not in the import, and missing or in trash)", expected, ref.id);
      else if (owner !== ref.collection) at(paths, `referenced entry belongs to "${owner}"`, expected, ref.id);
    }
  }

  // --- slugs held by a different entry already in the DB (trash included: the unique index covers it)
  const slugRows = await select<{ id: string; slug: string; cname: string; deleted_at: string | null }>(
    ctx,
    "SELECT e.id, e.slug, c.name AS cname, e.deleted_at FROM entries e JOIN collections c ON c.id = e.collection_id " +
      "WHERE e.slug IN (SELECT value FROM json_each(?))",
    [...new Set(entries.flatMap((e) => (e.slug === null ? [] : [e.slug])))],
  );
  for (const e of entries) {
    const holder = slugRows.find((r) => r.slug === e.slug && r.cname === e.collection && r.id !== e.id);
    if (holder) {
      push(`entries[${e.index}].slug`, `slug "${e.slug}" は既存のエントリ ${holder.id} が使っています${holder.deleted_at ? "（ゴミ箱内）" : ""}`,
        "unused slug", e.slug);
    }
  }

  // --- single collections hold at most one live entry
  const singles = [...defs.values()].filter((d) => d.def.kind === "single").map((d) => ({ id: d.id, name: d.def.name, at: `collections[${d.index}].kind` }))
    .concat([...live.values()].filter((c) => c.kind === "single" && !defs.has(c.name)).map((c) => ({ id: c.id, name: c.name, at: "" })));
  const existingInSingles = replace ? [] : await select<{ id: string; collection_id: string }>(
    ctx, "SELECT id, collection_id FROM entries WHERE deleted_at IS NULL AND collection_id IN (SELECT value FROM json_each(?))",
    singles.map((s) => s.id),
  );
  for (const s of singles) {
    const imported = entries.filter((e) => e.collectionId === s.id);
    const ids = new Set([...existingInSingles.filter((r) => r.collection_id === s.id).map((r) => r.id), ...imported.map((e) => e.id)]);
    if (ids.size > 1) {
      push(imported.length ? `entries[${imported[imported.length - 1].index}]` : s.at,
        `single コレクション "${s.name}" には有効なエントリを 1 件までしか置けません`);
    }
  }

  // --- what R2 / the media table already hold under the imported ids (also decides what a failed import may delete)
  const sizes = await r2Sizes(ctx, new Set(media.map((m) => m.record.id)));
  const rows = new Set((await select<{ id: string }>(
    ctx, "SELECT id FROM media WHERE id IN (SELECT value FROM json_each(?))", media.map((m) => m.record.id),
  )).map((r) => r.id));
  for (const m of media) m.preexisting = sizes.has(m.record.id) || rows.has(m.record.id);

  // --- media files that are not fetched: R2 must already hold them
  const local = media.filter((m) => !m.url || new URL(m.url).origin === ctx.origin);
  for (const m of local) {
    const size = sizes.get(m.record.id);
    if (size !== undefined) {
      m.inR2 = true; // url-less, or our own file: no need to download it
      m.record.size = size;
    } else if (!m.url) {
      push(`media[${m.index}].url`, `url が無く、R2 にも ${r2Key(m.record.id)} がありません`, `url, or a file already uploaded as ${r2Key(m.record.id)}`);
    }
  }

  if (issues.length) throw invalid(issues, "取り込むデータが不正です。何も書き込んでいません");
  return {
    collections: planned, existingCollectionIds: planned.filter((p) => dbByName.has(p.def.name)).map((p) => p.id),
    entries, media,
  };
}

/**
 * Downloads every media file with a url into R2 and returns the ids it wrote. Any failure is reported against its media
 * path; D1 is still untouched. On failure, the objects written here for brand-new ids are deleted again (no row would
 * ever point at them, and a non-empty bucket blocks destroy). Objects under ids that existed before are left alone:
 * they may already have been overwritten, but deleting them would lose the file the existing row points at.
 */
async function storeMedia(ctx: Ctx, media: PlannedMedia[]): Promise<PlannedMedia[]> {
  const issues: Issue[] = [];
  const written: PlannedMedia[] = [];
  try {
    for (const m of media) {
      if (m.inR2 || !m.url) continue;
      try {
        const { bytes } = await fetchRemoteMedia(m.url);
        // The export's own metadata wins (served content types are forced to octet-stream for unsafe types); size and dimensions come from the bytes.
        const stored = await putMediaObject(ctx, { bytes, filename: m.record.filename, mimeType: m.record.mimeType, alt: m.record.alt }, m.record.id);
        written.push(m);
        m.record = { ...stored, createdAt: m.record.createdAt };
      } catch (e) {
        if (!(e instanceof FemtoError)) throw e;
        issues.push({ path: `media[${m.index}].url`, message: e.message, ...(e.hint ? { expected: e.hint } : {}) });
      }
    }
    if (issues.length) throw invalid(issues, "メディアを取得できませんでした。D1 には何も書き込んでいません");
  } catch (e) {
    await removeNewObjects(ctx, written);
    throw e;
  }
  return written;
}

/** Deletes the R2 objects of `written` whose ids were not in use before the import. */
async function removeNewObjects(ctx: Ctx, written: PlannedMedia[]): Promise<void> {
  const keys = written.filter((m) => !m.preexisting).map((m) => r2Key(m.record.id));
  if (keys.length) await ctx.bucket.delete(keys).catch(() => {});
}

/** One INSERT ... SELECT per chunk of rows: the rows are a JSON array in a single bound parameter, so a big import stays a handful of statements. */
function upsertChunks(ctx: Ctx, sql: string, rows: Record<string, unknown>[]): D1PreparedStatement[] {
  const enc = new TextEncoder();
  const out: D1PreparedStatement[] = [];
  let chunk: Record<string, unknown>[] = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length) out.push(ctx.db.prepare(sql).bind(JSON.stringify(chunk)));
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = enc.encode(JSON.stringify(row)).length;
    if (bytes + size > CHUNK_BYTES) flush();
    chunk.push(row);
    bytes += size;
  }
  flush();
  return out;
}

const J = (key: string) => `json_extract(value, '$.${key}')`;

export async function importData(
  ctx: Ctx, input: { data: ExportData; mode: "merge" | "replace"; confirm?: string },
): Promise<{ collections: number; entries: number; media: number }> {
  requireRole(ctx, "admin");
  if (input.mode !== "merge" && input.mode !== "replace") {
    throw invalid([{ path: "mode", message: 'mode は "merge" か "replace" です', expected: "merge | replace", received: input.mode }]);
  }
  const replace = input.mode === "replace";
  if (replace) requireConfirm(ctx, input.confirm);

  const plan = await planImport(ctx, input.data, replace);
  // storeMedia removes what it wrote for new ids when a media file fails; the D1 batch below does the same if it fails.
  const written = await storeMedia(ctx, plan.media);

  const now = ctx.now().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (replace) statements.push(...trashAllStatements(ctx)); // inside the same batch: it only happens if everything else is written
  statements.push(
    ...upsertChunks(
      ctx,
      "INSERT INTO collections (id, name, label, description, kind, public, fields, created_at, updated_at, deleted_at) " +
        `SELECT ${J("id")}, ${J("name")}, ${J("label")}, ${J("description")}, ${J("kind")}, ${J("public")}, ${J("fields")}, ${J("now")}, ${J("now")}, NULL ` +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT(name) DO UPDATE SET label = excluded.label, description = excluded.description, kind = excluded.kind, " +
        "public = excluded.public, fields = excluded.fields, updated_at = excluded.updated_at, deleted_at = NULL",
      plan.collections.map(({ def, id }) => ({
        id, name: def.name, label: def.label ?? null, description: def.description ?? null, kind: def.kind ?? "list",
        public: def.public === false ? 0 : 1, fields: JSON.stringify(def.fields), now,
      })),
    ),
  );
  if (plan.existingCollectionIds.length) {
    // Entries that were trashed together with a collection that is now live again stay in the trash as items of their own.
    statements.push(
      ctx.db.prepare("UPDATE entries SET trashed_with = NULL WHERE trashed_with IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(plan.existingCollectionIds)),
    );
  }
  statements.push(
    ...upsertChunks(
      ctx,
      "INSERT INTO media (id, filename, mime_type, size, width, height, alt, created_at, deleted_at) " +
        `SELECT ${J("id")}, ${J("filename")}, ${J("mimeType")}, ${J("size")}, ${J("width")}, ${J("height")}, ${J("alt")}, ${J("createdAt")}, NULL ` +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, mime_type = excluded.mime_type, size = excluded.size, " +
        "width = excluded.width, height = excluded.height, alt = excluded.alt, created_at = excluded.created_at, deleted_at = NULL",
      plan.media.map((m) => ({ ...m.record })),
    ),
    ...upsertChunks(
      ctx,
      "INSERT INTO entries (id, collection_id, slug, status, data, created_at, updated_at, published_at, deleted_at, trashed_with) " +
        `SELECT ${J("id")}, ${J("collectionId")}, ${J("slug")}, ${J("status")}, ${J("data")}, ${J("createdAt")}, ${J("updatedAt")}, ${J("publishedAt")}, NULL, NULL ` +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id, slug = excluded.slug, status = excluded.status, " +
        "data = excluded.data, created_at = excluded.created_at, updated_at = excluded.updated_at, published_at = excluded.published_at, " +
        "deleted_at = NULL, trashed_with = NULL",
      plan.entries.map(({ id, collectionId, slug, status, data, createdAt, updatedAt, publishedAt }) => (
        { id, collectionId, slug, status, data: JSON.stringify(data), createdAt, updatedAt, publishedAt }
      )),
    ),
  );
  try {
    await ctx.db.batch(statements); // one transaction: all of it or none of it
  } catch (e) {
    await removeNewObjects(ctx, written);
    throw e;
  }
  await bumpVersion(ctx);
  return { collections: plan.collections.length, entries: plan.entries.length, media: plan.media.length };
}
