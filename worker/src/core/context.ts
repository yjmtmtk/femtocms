import type { Env } from "../env";
import { FemtoError } from "./errors";
import type { Role } from "./types";

export interface Ctx {
  env: Env;
  db: D1Database;
  bucket: R2Bucket;
  siteName: string;
  origin: string;
  role: Role;
  now(): Date;
}

export function createCtx(env: Env, origin: string, role: Role): Ctx {
  return {
    env,
    db: env.DB,
    bucket: env.MEDIA,
    siteName: env.SITE_NAME,
    origin,
    role,
    now: () => new Date(),
  };
}

const LEVEL: Record<Role, number> = { public: 0, read: 1, admin: 2 };

/** admin satisfies read. A caller with too low a role gets `unauthorized` if anonymous, else `forbidden`. */
export function requireRole(ctx: Ctx, role: "admin" | "read"): void {
  if (LEVEL[ctx.role] >= LEVEL[role]) return;
  if (ctx.role === "public") {
    throw new FemtoError("unauthorized", "Authentication required", { hint: "Send the header Authorization: Bearer <API key>." });
  }
  throw new FemtoError("forbidden", `This operation requires the ${role} role`);
}

export function requireConfirm(ctx: Ctx, confirm: string | undefined): void {
  if (confirm !== ctx.siteName) {
    throw new FemtoError("confirmation_required", "Confirmation required", {
      hint: `Set confirm to "${ctx.siteName}".`,
    });
  }
}

export async function getSetting(ctx: Ctx, key: string): Promise<string | null> {
  const row = await ctx.db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(ctx: Ctx, key: string, value: string): Promise<void> {
  await ctx.db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function bumpVersion(ctx: Ctx): Promise<void> {
  await ctx.db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('content_version', '1') " +
        "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
    )
    .run();
}
