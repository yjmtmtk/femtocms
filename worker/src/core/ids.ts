// Pure module (Web Crypto only): the CLI imports this too. No Env / D1 / cloudflare:* imports.

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const COLLECTION_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
export const RESERVED_COLLECTION_NAMES: readonly string[] = [
  "collections", "media", "trash", "keys", "export", "import", "reset", "openapi.json",
];

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 12;

export function newId(prefix: "e" | "m" | "c" | "k"): string {
  // 252 = 36 * 7: rejecting bytes >= 252 keeps the modulo unbiased.
  let out = "";
  while (out.length < ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2));
    for (const b of bytes) {
      if (b < 252 && out.length < ID_LENGTH) out += ALPHABET[b % 36];
    }
  }
  return `${prefix}_${out}`;
}
