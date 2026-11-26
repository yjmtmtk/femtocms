import type { Env } from "../env";
import { requireRole, type Ctx } from "./context";
import { FemtoError } from "./errors";
import { newId } from "./ids";
import { KEY_PREFIX_LENGTH, KEY_RE, checkKeyName, generateKey, hashKey } from "./key-format";
import type { Role } from "./types";

export interface ApiKeyInfo {
  id: string;
  name: string;
  role: "admin" | "read";
  /** First 16 characters of the plaintext key. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface KeyRow {
  id: string; name: string; role: "admin" | "read"; prefix: string;
  created_at: string; last_used_at: string | null; revoked_at: string | null;
}

const COLUMNS = "id, name, role, prefix, created_at, last_used_at, revoked_at";

const toInfo = (r: KeyRow): ApiKeyInfo => ({
  id: r.id, name: r.name, role: r.role, prefix: r.prefix,
  createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
});

/** The plaintext key is returned here and nowhere else; only its SHA-256 is stored. */
export async function createKey(
  ctx: Ctx, input: { name: string; role: "admin" | "read" },
): Promise<{ key: string; info: ApiKeyInfo }> {
  requireRole(ctx, "admin");
  const checked = checkKeyName(input?.name);
  if (!checked.ok) {
    throw new FemtoError("validation_failed", "キーの名前が不正です", { issues: [{ path: "name", message: checked.message }] });
  }
  if (input.role !== "admin" && input.role !== "read") {
    throw new FemtoError("validation_failed", "キーの role が不正です", {
      issues: [{ path: "role", message: 'role は "admin" か "read" です', expected: "admin | read", received: input.role }],
    });
  }
  const key = generateKey(input.role);
  const id = newId("k");
  const createdAt = ctx.now().toISOString();
  await ctx.db
    .prepare("INSERT INTO api_keys (id, name, role, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, checked.name, input.role, await hashKey(key), key.slice(0, KEY_PREFIX_LENGTH), createdAt)
    .run();
  return { key, info: { id, name: checked.name, role: input.role, prefix: key.slice(0, KEY_PREFIX_LENGTH), createdAt, lastUsedAt: null, revokedAt: null } };
}

/** Newest first, revoked keys included. Never exposes the hash. */
export async function listKeys(ctx: Ctx): Promise<ApiKeyInfo[]> {
  requireRole(ctx, "admin");
  const { results } = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM api_keys ORDER BY created_at DESC, rowid DESC`)
    .all<KeyRow>();
  return results.map(toInfo);
}

const fetchKey = (ctx: Ctx, id: string) =>
  ctx.db.prepare(`SELECT ${COLUMNS} FROM api_keys WHERE id = ?`).bind(id).first<KeyRow>();

/** Idempotent. The last active admin key is protected by a single conditional UPDATE, so concurrent revokes can't both win. */
export async function revokeKey(ctx: Ctx, id: string): Promise<ApiKeyInfo> {
  requireRole(ctx, "admin");
  const existing = await fetchKey(ctx, id);
  if (!existing) throw new FemtoError("not_found", `キー "${id}" が見つかりません`, { hint: "list_keys で一覧を確認してください" });
  if (existing.revoked_at) return toInfo(existing);

  const res = await ctx.db
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND (role != 'admin' OR EXISTS " +
        "(SELECT 1 FROM api_keys WHERE role = 'admin' AND revoked_at IS NULL AND id != ?))",
    )
    .bind(ctx.now().toISOString(), id, id)
    .run();
  const after = (await fetchKey(ctx, id))!;
  if (res.meta.changes === 0 && !after.revoked_at) {
    throw new FemtoError("conflict", "最後の有効な管理キーは revoke できません", {
      hint: "先に別の管理キーを作成してから revoke してください",
    });
  }
  return toInfo(after);
}

const unauthorized = () =>
  new FemtoError("unauthorized", "APIキーが無効です", {
    hint: "Authorization: Bearer <APIキー> を確認してください（revoke 済みのキーは使えません）",
  });

const TOUCH_INTERVAL_MS = 60_000;

/**
 * No Authorization header -> public. Anything present must be `Bearer <valid active key>`, otherwise `unauthorized`
 * (unknown, malformed and revoked keys are indistinguishable to the caller). The token is never logged or echoed.
 */
export async function resolveRole(
  env: Env, authorization: string | null, waitUntil?: (p: Promise<unknown>) => void,
): Promise<Role> {
  if (authorization === null) return "public";
  const m = /^bearer +(\S+)$/i.exec(authorization);
  if (!m || !KEY_RE.test(m[1]!)) throw unauthorized();

  const row = await env.DB
    .prepare("SELECT id, role, last_used_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
    .bind(await hashKey(m[1]!))
    .first<{ id: string; role: "admin" | "read"; last_used_at: string | null }>();
  if (!row) throw unauthorized();

  if (waitUntil) {
    const now = Date.now();
    if (!row.last_used_at || now - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS) {
      // Best effort: a failed bookkeeping write must never fail (or be awaited by) the request.
      waitUntil(
        env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
          .bind(new Date(now).toISOString(), row.id).run().catch(() => undefined),
      );
    }
  }
  return row.role;
}
