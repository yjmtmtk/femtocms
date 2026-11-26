import { getCollectionRow } from "./collections";
import { createCtx, getSetting, requireRole, type Ctx } from "./context";
import { FemtoError } from "./errors";
import { getEntryRecord } from "./entries";
import { presentEntry, type ApiEntry, type PresentOpts } from "./present";
import type { Collection } from "./types";

export const DEFAULT_PREVIEW_TTL_SECONDS = 86_400;
export const MAX_PREVIEW_TTL_SECONDS = 2_592_000;

const SECRET_KEY = "preview_secret";
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const unauthorized = (why: string) =>
  new FemtoError("unauthorized", `プレビュー URL が無効です (${why})`, { hint: "POST /api/<collection>/<id>/preview で新しい URL を発行してください" });

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Strict: only the url-safe alphabet and canonical (re-encodes to the same text); null otherwise. */
function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return b64urlEncode(bytes) === s ? bytes : null;
  } catch {
    return null;
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function getSecret(ctx: Ctx): Promise<string> {
  const existing = await getSetting(ctx, SECRET_KEY);
  if (existing) return existing;
  // DO NOTHING + re-read: concurrent first uses all end up with whichever secret was stored first.
  await ctx.db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
    .bind(SECRET_KEY, hex(crypto.getRandomValues(new Uint8Array(32))))
    .run();
  return (await getSetting(ctx, SECRET_KEY))!;
}

async function hmacKey(ctx: Ctx, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(await getSecret(ctx)), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Admin only. `idOrSlug` may be a slug; the token always carries the entry id. Drafts are allowed. */
export async function createPreviewUrl(
  ctx: Ctx, collection: string, idOrSlug: string, opts?: { ttlSeconds?: number },
): Promise<{ url: string; token: string; expiresAt: string }> {
  requireRole(ctx, "admin");
  const entry = await getEntryRecord(ctx, collection, idOrSlug, { allowDraft: true });
  const exp = Math.floor(ctx.now().getTime() / 1000) + (opts?.ttlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS);
  const payload = b64urlEncode(enc.encode(`${entry.id}.${exp}`));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(ctx, "sign"), enc.encode(payload));
  const token = `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
  return { url: `${ctx.origin}/preview/${token}`, token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Any role may call this: the token itself is the credential. Malformed, forged and expired tokens are all `unauthorized`. */
export async function verifyPreviewToken(ctx: Ctx, token: string): Promise<{ entryId: string }> {
  const parts = token.split(".");
  if (parts.length !== 2) throw unauthorized("形式");
  const [payloadB64, sigB64] = parts;
  const sig = b64urlDecode(sigB64);
  const payloadBytes = b64urlDecode(payloadB64);
  if (!sig || !payloadBytes) throw unauthorized("形式");
  // verify() compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(ctx, "verify"), sig, enc.encode(payloadB64)))) throw unauthorized("署名");
  let payload: string;
  try {
    payload = dec.decode(payloadBytes);
  } catch {
    throw unauthorized("形式");
  }
  const m = /^(e_[0-9a-z]{12})\.(\d{1,12})$/.exec(payload);
  if (!m) throw unauthorized("形式");
  if (Number(m[2]) <= Math.floor(ctx.now().getTime() / 1000)) throw unauthorized("期限切れ");
  return { entryId: m[1] };
}

/** Collection name of a live (not trashed) entry, looked up by id alone since the token carries no collection. */
async function collectionOfEntry(ctx: Ctx, entryId: string): Promise<string | null> {
  const row = await ctx.db
    .prepare(
      "SELECT c.name AS name FROM entries e JOIN collections c ON c.id = e.collection_id " +
        "WHERE e.id = ? AND e.deleted_at IS NULL AND c.deleted_at IS NULL",
    )
    .bind(entryId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

/** Loads the one entry a `/preview/:token` URL grants (drafts included, no expansion). Trashed or missing -> not_found. */
export async function loadPreview(ctx: Ctx, token: string): Promise<{ collection: Collection; entry: ApiEntry }> {
  const { entryId } = await verifyPreviewToken(ctx, token);
  const name = await collectionOfEntry(ctx, entryId);
  if (!name) throw new FemtoError("not_found", "プレビュー対象の記事が見つかりません", { hint: "記事が削除された可能性があります" });
  // Admin-equivalent visibility, but only for this single entry.
  const adminCtx = createCtx(ctx.env, ctx.origin, "admin");
  const record = await getEntryRecord(adminCtx, name, entryId, { allowDraft: true });
  const collection = await getCollectionRow(adminCtx, name);
  return { collection, entry: await presentEntry(adminCtx, collection, record, {}) };
}

/**
 * `GET /api/:c/:id?preview=<token>`: the normal read first; if it fails with not_found and the token is for exactly this
 * entry, return the draft instead. An invalid token is `unauthorized`; a valid token for another entry changes nothing.
 */
export async function readEntryWithPreview(
  ctx: Ctx, collection: string, idOrSlug: string, token: string, opts: PresentOpts,
): Promise<ApiEntry> {
  const { entryId } = await verifyPreviewToken(ctx, token);
  const adminCtx = createCtx(ctx.env, ctx.origin, "admin");
  const coll = await getCollectionRow(adminCtx, collection);
  let record;
  try {
    record = await getEntryRecord(ctx, collection, idOrSlug);
  } catch (err) {
    if (!(err instanceof FemtoError) || err.code !== "not_found") throw err;
    const draft = await getEntryRecord(adminCtx, collection, idOrSlug, { allowDraft: true }).catch(() => null);
    if (!draft || draft.id !== entryId) throw err;
    record = draft;
  }
  return presentEntry(ctx, coll, record, opts);
}
