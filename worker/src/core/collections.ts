import { parseCollectionInput } from "./collection-def";
import { bumpVersion, requireRole, type Ctx } from "./context";
import { FemtoError } from "./errors";
import { newId } from "./ids";
import type { Collection, FieldDef } from "./types";

interface CollectionRow {
  id: string; name: string; label: string | null; description: string | null;
  kind: "list" | "single"; public: number; fields: string;
  created_at: string; updated_at: string; deleted_at: string | null;
}

function toCollection(r: CollectionRow): Collection {
  return {
    id: r.id, name: r.name, label: r.label, description: r.description, kind: r.kind,
    public: r.public === 1, fields: JSON.parse(r.fields) as FieldDef[],
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const notFound = (name: string) =>
  new FemtoError("not_found", `コレクション "${name}" が見つかりません`, { hint: "list_collections で一覧を確認してください" });

/** Internal: no role check (callers do their own). Trashed collections are hidden unless includeTrashed. */
export async function getCollectionRow(
  ctx: Ctx, name: string, opts?: { includeTrashed?: boolean },
): Promise<Collection> {
  const sql = "SELECT * FROM collections WHERE name = ?" + (opts?.includeTrashed ? "" : " AND deleted_at IS NULL");
  const row = await ctx.db.prepare(sql).bind(name).first<CollectionRow>();
  if (!row) throw notFound(name);
  return toCollection(row);
}

// Reads: any role may read public collections; read/admin may read all. Non-public ones look absent to `public`.
export async function listCollections(ctx: Ctx): Promise<Collection[]> {
  const sql = "SELECT * FROM collections WHERE deleted_at IS NULL" + (ctx.role === "public" ? " AND public = 1" : "") + " ORDER BY name";
  const { results } = await ctx.db.prepare(sql).all<CollectionRow>();
  return results.map(toCollection);
}

export async function getCollection(ctx: Ctx, name: string): Promise<Collection> {
  const c = await getCollectionRow(ctx, name);
  if (ctx.role === "public" && !c.public) throw notFound(name);
  return c;
}

export async function createCollection(ctx: Ctx, input: unknown): Promise<Collection> {
  requireRole(ctx, "admin");
  const def = parseCollectionInput(input, "create");
  const existing = await ctx.db
    .prepare("SELECT deleted_at FROM collections WHERE name = ?").bind(def.name).first<{ deleted_at: string | null }>();
  if (existing) {
    throw new FemtoError("conflict", `コレクション "${def.name}" は既に存在します`, {
      hint: existing.deleted_at
        ? "ゴミ箱にあります。restore_from_trash で戻すか、ゴミ箱を空にしてから作成してください"
        : "別の名前を使うか、update_collection で変更してください",
    });
  }
  const now = ctx.now().toISOString();
  const id = newId("c");
  await ctx.db
    .prepare(
      "INSERT INTO collections (id, name, label, description, kind, public, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, def.name, def.label ?? null, def.description ?? null, def.kind ?? "list",
      def.public === false ? 0 : 1, JSON.stringify(def.fields), now, now)
    .run();
  await bumpVersion(ctx);
  return getCollectionRow(ctx, def.name);
}

function referencedCollections(fields: FieldDef[]): Array<{ path: string; collection: string }> {
  const out: Array<{ path: string; collection: string }> = [];
  const walk = (fs: FieldDef[], base: string) =>
    fs.forEach((f, i) => {
      if (f.type === "reference" && f.collection) out.push({ path: `${base}[${i}].collection`, collection: f.collection });
      if (f.fields) walk(f.fields, `${base}[${i}].fields`);
    });
  walk(fields, "fields");
  return out;
}

export async function updateCollection(ctx: Ctx, name: string, patch: unknown): Promise<Collection> {
  requireRole(ctx, "admin");
  const current = await getCollectionRow(ctx, name);
  const def = parseCollectionInput(patch, "update");
  if (def.name !== undefined && def.name !== current.name) {
    throw new FemtoError("validation_failed", "コレクション名は変更できません", {
      issues: [{ path: "name", message: "作成後に name は変更できません", expected: current.name, received: def.name }],
    });
  }
  if (def.kind === "single" && current.kind !== "single") {
    const { n } = (await ctx.db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE collection_id = ? AND deleted_at IS NULL")
      .bind(current.id).first<{ n: number }>())!;
    if (n >= 2) {
      throw new FemtoError("conflict", `有効なエントリが ${n} 件あるため single にできません`, {
        hint: "エントリを1件になるまでゴミ箱へ移してから変更してください",
      });
    }
  }
  if (def.fields) {
    const issues = [];
    for (const ref of referencedCollections(def.fields)) {
      if (ref.collection === current.name) continue;
      const found = await ctx.db
        .prepare("SELECT 1 AS x FROM collections WHERE name = ? AND deleted_at IS NULL").bind(ref.collection).first();
      if (!found) issues.push({ path: ref.path, message: `参照先コレクション "${ref.collection}" が存在しません` });
    }
    if (issues.length) throw new FemtoError("validation_failed", "コレクション定義が不正です", { issues });
  }
  await ctx.db
    .prepare("UPDATE collections SET label = ?, description = ?, kind = ?, public = ?, fields = ?, updated_at = ? WHERE id = ?")
    .bind(
      def.label ?? current.label, def.description ?? current.description, def.kind ?? current.kind,
      (def.public ?? current.public) ? 1 : 0, JSON.stringify(def.fields ?? current.fields),
      ctx.now().toISOString(), current.id,
    )
    .run();
  await bumpVersion(ctx);
  return getCollectionRow(ctx, name);
}
