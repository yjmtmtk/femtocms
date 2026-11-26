// Pure module (Web Crypto only): the CLI imports this too. No Env / D1 / Ctx / cloudflare:* imports.
import { newId } from "./ids";

export const ADMIN_KEY_PREFIX = "fcms_admin_";
export const READ_KEY_PREFIX = "fcms_read_";
/** How much of the plaintext key is stored (and shown) so a key can be recognised without revealing it. */
export const KEY_PREFIX_LENGTH = 16;
export const KEY_NAME_MAX = 100;
/** Matches any key we generate. Checked before touching the DB so garbage never costs a query. */
export const KEY_RE = /^fcms_(?:admin|read)_[0-9a-zA-Z]{32}$/;
const ADMIN_KEY_RE = /^fcms_admin_[0-9a-zA-Z]{32}$/;

const CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
// 248 = 62 * 4: rejecting bytes >= 248 keeps the modulo unbiased.
const LIMIT = 248;
const SECRET_LENGTH = 32;

export async function hashKey(plain: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateKey(role: "admin" | "read"): string {
  let secret = "";
  while (secret.length < SECRET_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(SECRET_LENGTH * 2))) {
      if (b < LIMIT && secret.length < SECRET_LENGTH) secret += CHARS[b % 62];
    }
  }
  return (role === "admin" ? ADMIN_KEY_PREFIX : READ_KEY_PREFIX) + secret;
}

// C0/C1 controls (incl. newline, tab, NUL) and the Unicode line/paragraph separators.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Returns the trimmed name, or a human-readable problem (shared by createKey and bootstrapSql). */
export function checkKeyName(name: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof name !== "string") return { ok: false, message: "name は文字列で指定してください" };
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > KEY_NAME_MAX) {
    return { ok: false, message: `name は 1〜${KEY_NAME_MAX} 文字で指定してください` };
  }
  if (CONTROL_RE.test(trimmed)) return { ok: false, message: "name に改行・制御文字は使えません" };
  return { ok: true, name: trimmed };
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** One-line INSERT for `wrangler d1 execute --command`. The plaintext key never appears in the SQL. */
export async function bootstrapSql(plainAdminKey: string, name: string, nowIso: string): Promise<string> {
  if (!ADMIN_KEY_RE.test(plainAdminKey)) throw new Error("plainAdminKey must look like fcms_admin_ + 32 alphanumeric characters");
  const checked = checkKeyName(name);
  if (!checked.ok) throw new Error(checked.message);
  if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(nowIso)) throw new Error("nowIso must be an ISO 8601 UTC timestamp");
  const hash = await hashKey(plainAdminKey);
  return (
    "INSERT INTO api_keys (id, name, role, hash, prefix, created_at) VALUES (" +
    [newId("k"), checked.name, "admin", hash, plainAdminKey.slice(0, KEY_PREFIX_LENGTH), nowIso].map(sqlString).join(", ") +
    ")"
  );
}
