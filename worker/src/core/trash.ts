import { getCollectionRow } from "./collections";
import { bumpVersion, requireConfirm, requireRole, type Ctx } from "./context";
import { FemtoError } from "./errors";
import type { FieldDef } from "./types";

export interface TrashItem {
  type: "entry" | "media" | "collection";
  id: string;
  title: string;
  collection?: string;
  deletedAt: string;
}

const r2Key = (id: string) => `media/${id}`;
const R2_DELETE_BATCH = 1000;

interface EntryTrashRow {
  id: string; slug: string | null; data: string; deleted_at: string | null; trashed_with: string | null;
  collection_id: string; cname: string; ckind: string; cfields: string; c_deleted: string | null;
}

// First `text` field of the collection with a non-empty string value, else the slug, else the id.
function entryTitle(r: EntryTrashRow): string {
  const fields = JSON.parse(r.cfields) as FieldDef[];
  const data = JSON.parse(r.data) as Record<string, unknown>;
  const first = fields.find((f) => f.type === "text");
  const v = first ? data[first.name] : undefined;
  return typeof v === "string" && v !== "" ? v : (r.slug ?? r.id);
}

const entryItem = (r: EntryTrashRow): TrashItem =>
  ({ type: "entry", id: r.id, title: entryTitle(r), collection: r.cname, deletedAt: r.deleted_at ?? "" });

const ENTRY_SELECT =
  "SELECT e.id, e.slug, e.data, e.deleted_at, e.trashed_with, e.collection_id, " +
  "c.name AS cname, c.kind AS ckind, c.fields AS cfields, c.deleted_at AS c_deleted " +
  "FROM entries e JOIN collections c ON c.id = e.collection_id";

const notInTrash = (id: string) =>
  new FemtoError("not_found", `"${id}" not found in the trash`, { hint: "Call list_trash to see what is in the trash." });

export async function trashEntry(ctx: Ctx, collection: string, idOrSlug: string): Promise<void> {
  requireRole(ctx, "admin");
  const c = await getCollectionRow(ctx, collection);
  const row = await ctx.db
    .prepare("SELECT id FROM entries WHERE collection_id = ? AND deleted_at IS NULL AND (id = ? OR slug = ?)")
    .bind(c.id, idOrSlug, idOrSlug).first<{ id: string }>();
  if (!row) {
    throw new FemtoError("not_found", `Entry "${idOrSlug}" not found in collection "${collection}"`, {
      hint: "Call list_entries to see the existing entries.",
    });
  }
  await ctx.db.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?").bind(ctx.now().toISOString(), row.id).run();
  await bumpVersion(ctx);
}

export async function trashMedia(ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, "admin");
  const res = await ctx.db
    .prepare("UPDATE media SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(ctx.now().toISOString(), id).run();
  if (res.meta.changes === 0) {
    throw new FemtoError("not_found", `Media "${id}" not found`, { hint: "Call list_media to see the existing media." });
  }
  await bumpVersion(ctx);
}

export async function trashCollection(ctx: Ctx, name: string): Promise<void> {
  requireRole(ctx, "admin");
  const c = await getCollectionRow(ctx, name);
  const now = ctx.now().toISOString();
  // Entries already in the trash keep their own deleted_at and stay unmarked, so restoring the collection leaves them there.
  await ctx.db.batch([
    ctx.db.prepare("UPDATE collections SET deleted_at = ? WHERE id = ?").bind(now, c.id),
    ctx.db
      .prepare("UPDATE entries SET deleted_at = ?, trashed_with = ? WHERE collection_id = ? AND deleted_at IS NULL")
      .bind(now, c.id, c.id),
  ]);
  await bumpVersion(ctx);
}

async function trashedEntries(ctx: Ctx, where: string, ...binds: unknown[]): Promise<EntryTrashRow[]> {
  const { results } = await ctx.db.prepare(`${ENTRY_SELECT} WHERE e.deleted_at IS NOT NULL ${where}`)
    .bind(...binds).all<EntryTrashRow>();
  return results;
}

async function trashedMedia(ctx: Ctx): Promise<TrashItem[]> {
  const { results } = await ctx.db
    .prepare("SELECT id, filename, deleted_at FROM media WHERE deleted_at IS NOT NULL")
    .all<{ id: string; filename: string; deleted_at: string }>();
  return results.map((r) => ({ type: "media", id: r.id, title: r.filename, deletedAt: r.deleted_at }));
}

async function trashedCollections(ctx: Ctx): Promise<TrashItem[]> {
  const { results } = await ctx.db
    .prepare("SELECT id, name, deleted_at FROM collections WHERE deleted_at IS NOT NULL")
    .all<{ id: string; name: string; deleted_at: string }>();
  return results.map((r) => ({ type: "collection", id: r.id, title: r.name, deletedAt: r.deleted_at }));
}

/** Newest first. Entries trashed together with their collection are part of that collection's item, not listed. */
export async function listTrash(ctx: Ctx): Promise<TrashItem[]> {
  requireRole(ctx, "admin");
  const [entries, media, collections] = await Promise.all([
    trashedEntries(ctx, "AND e.trashed_with IS NULL"), trashedMedia(ctx), trashedCollections(ctx),
  ]);
  return [...entries.map(entryItem), ...media, ...collections]
    .sort((a, b) => (a.deletedAt === b.deletedAt ? a.id.localeCompare(b.id) : a.deletedAt < b.deletedAt ? 1 : -1));
}

type Kind = TrashItem["type"];

function kindOf(id: string): Kind {
  if (id.startsWith("e_")) return "entry";
  if (id.startsWith("m_")) return "media";
  if (id.startsWith("c_")) return "collection";
  throw new FemtoError("bad_request", `Cannot tell what kind of item id "${id}" is`, {
    hint: "Pass an id that starts with e_ (entry), m_ (media) or c_ (collection).",
  });
}

/** The item with this id as it is now: `trashed` tells whether it is in the trash. null when it does not exist. */
async function findItem(ctx: Ctx, kind: Kind, id: string): Promise<{ item: TrashItem; trashed: boolean; entry?: EntryTrashRow } | null> {
  if (kind === "entry") {
    const r = await ctx.db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).bind(id).first<EntryTrashRow>();
    return r && { item: entryItem(r), trashed: r.deleted_at !== null, entry: r };
  }
  const sql = kind === "media"
    ? "SELECT id, filename AS title, deleted_at FROM media WHERE id = ?"
    : "SELECT id, name AS title, deleted_at FROM collections WHERE id = ?";
  const r = await ctx.db.prepare(sql).bind(id).first<{ id: string; title: string; deleted_at: string | null }>();
  return r && { item: { type: kind, id: r.id, title: r.title, deletedAt: r.deleted_at ?? "" }, trashed: r.deleted_at !== null };
}

export async function restoreFromTrash(ctx: Ctx, id: string): Promise<TrashItem> {
  requireRole(ctx, "admin");
  const kind = kindOf(id);
  const found = await findItem(ctx, kind, id);
  if (!found?.trashed) throw notInTrash(id);

  if (kind === "entry") {
    const e = found.entry!;
    if (e.c_deleted) {
      throw new FemtoError("conflict", `Parent collection "${e.cname}" is in the trash`, {
        hint: `Restore collection ${e.cname} first.`,
      });
    }
    if (e.ckind === "single" && await ctx.db.prepare("SELECT 1 AS x FROM entries WHERE collection_id = ? AND deleted_at IS NULL").bind(e.collection_id).first()) {
      throw new FemtoError("conflict", `Single collection "${e.cname}" already has another entry`, {
        hint: "Move the current entry to the trash, then restore this one.",
      });
    }
    await ctx.db.prepare("UPDATE entries SET deleted_at = NULL, trashed_with = NULL WHERE id = ?").bind(id).run();
  } else if (kind === "media") {
    await ctx.db.prepare("UPDATE media SET deleted_at = NULL WHERE id = ?").bind(id).run();
  } else {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE entries SET deleted_at = NULL, trashed_with = NULL WHERE trashed_with = ?").bind(id),
      ctx.db.prepare("UPDATE collections SET deleted_at = NULL WHERE id = ?").bind(id),
    ]);
  }
  await bumpVersion(ctx);
  return found.item;
}

async function deleteMediaObjects(ctx: Ctx, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += R2_DELETE_BATCH) {
    await ctx.bucket.delete(ids.slice(i, i + R2_DELETE_BATCH).map(r2Key));
  }
}

export async function deletePermanently(ctx: Ctx, id: string, confirm: string | undefined): Promise<void> {
  requireRole(ctx, "admin");
  const kind = kindOf(id);
  const found = await findItem(ctx, kind, id);
  if (!found) throw notInTrash(id);
  if (!found.trashed) {
    throw new FemtoError("bad_request", `"${id}" is not in the trash`, { hint: "Delete it first so that it moves to the trash." });
  }
  requireConfirm(ctx, confirm);

  if (kind === "entry") {
    await ctx.db.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
  } else if (kind === "media") {
    // R2 first: if the row delete then fails, the item is still in the trash and the delete can be retried.
    await deleteMediaObjects(ctx, [id]);
    await ctx.db.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
  } else {
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM entries WHERE collection_id = ?").bind(id),
      ctx.db.prepare("DELETE FROM collections WHERE id = ?").bind(id),
    ]);
  }
  await bumpVersion(ctx);
}

/** Deletes everything in the trash. `deleted` counts the items listTrash shows (a collection's own entries are part of it). */
export async function emptyTrash(ctx: Ctx, confirm: string | undefined): Promise<{ deleted: number }> {
  requireRole(ctx, "admin");
  requireConfirm(ctx, confirm);
  const items = await listTrash(ctx);
  const mediaIds = items.filter((i) => i.type === "media").map((i) => i.id);
  await deleteMediaObjects(ctx, mediaIds);
  await ctx.db.batch([
    ctx.db.prepare(
      "DELETE FROM entries WHERE deleted_at IS NOT NULL OR collection_id IN (SELECT id FROM collections WHERE deleted_at IS NOT NULL)",
    ),
    ctx.db.prepare("DELETE FROM collections WHERE deleted_at IS NOT NULL"),
    ctx.db.prepare("DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(mediaIds)),
  ]);
  await bumpVersion(ctx);
  return { deleted: items.length };
}
