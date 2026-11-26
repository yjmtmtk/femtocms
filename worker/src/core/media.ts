import { bumpVersion, requireRole, type Ctx } from "./context";
import { FemtoError } from "./errors";
import { newId } from "./ids";
import { imageSize } from "./image-size";
import type { MediaRecord } from "./types";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./query";

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 200;
const GENERIC_MIME = "application/octet-stream";
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
export const r2Key = (id: string) => `media/${id}`;

const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", xml: "application/xml", zip: "application/zip",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
};

interface MediaRow {
  id: string; filename: string; mime_type: string; size: number; width: number | null; height: number | null;
  alt: string; created_at: string;
}

const toRecord = (r: MediaRow): MediaRecord => ({
  id: r.id, filename: r.filename, mimeType: r.mime_type, size: r.size, width: r.width, height: r.height,
  alt: r.alt, createdAt: r.created_at,
});

// Path separators and control characters (incl. C1 and Unicode line/paragraph separators) are dropped; Unicode names are kept.
const UNSAFE_FILENAME_CHARS = /[\\\/\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(UNSAFE_FILENAME_CHARS, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
  const chars = Array.from(cleaned);
  if (chars.length <= MAX_FILENAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 20 ? Array.from(cleaned.slice(dot)) : [];
  return chars.slice(0, MAX_FILENAME_LENGTH - ext.length).concat(ext).join("");
}

/** Lower-cased type without parameters, or null when it is empty, malformed or the generic octet-stream. */
export function normalizeMime(raw: string | null | undefined): string | null {
  const m = (raw ?? "").split(";")[0].trim().toLowerCase();
  return MIME_RE.test(m) && m !== GENERIC_MIME ? m : null;
}

export function mimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return (dot >= 0 && EXT_MIME[filename.slice(dot + 1).toLowerCase()]) || GENERIC_MIME;
}

const tooLarge = () =>
  new FemtoError("payload_too_large", "ファイルが大きすぎます（上限 20MB）", { hint: "20MB 以下のファイルにしてください" });

async function findRow(ctx: Ctx, id: string): Promise<MediaRow | null> {
  return ctx.db.prepare("SELECT * FROM media WHERE id = ? AND deleted_at IS NULL").bind(id).first<MediaRow>();
}

export interface UploadInput { bytes: Uint8Array; filename: string; mimeType?: string; alt?: string }

/** Validates the bytes and writes the R2 object; returns the row to store. No D1 access (import batches the rows itself). */
export async function putMediaObject(ctx: Ctx, input: UploadInput, id: string): Promise<MediaRecord> {
  if (input.bytes.byteLength > MAX_MEDIA_BYTES) throw tooLarge();
  const filename = sanitizeFilename(input.filename);
  const mimeType = normalizeMime(input.mimeType) ?? mimeFromFilename(filename);
  const dims = imageSize(input.bytes, mimeType);
  await ctx.bucket.put(r2Key(id), input.bytes, { httpMetadata: { contentType: mimeType } });
  return {
    id, filename, mimeType, size: input.bytes.byteLength, width: dims?.width ?? null, height: dims?.height ?? null,
    alt: input.alt ?? "", createdAt: ctx.now().toISOString(),
  };
}

export async function uploadMedia(ctx: Ctx, input: UploadInput, internal?: { id?: string }): Promise<MediaRecord> {
  requireRole(ctx, "admin");
  const id = internal?.id ?? newId("m");
  const m = await putMediaObject(ctx, input, id);
  // internal.id may name an existing row (import): overwrite it, keep its created_at, and bring it back from the trash.
  await ctx.db
    .prepare(
      "INSERT INTO media (id, filename, mime_type, size, width, height, alt, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) " +
        "ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, mime_type = excluded.mime_type, size = excluded.size, " +
        "width = excluded.width, height = excluded.height, alt = excluded.alt, deleted_at = NULL",
    )
    .bind(id, m.filename, m.mimeType, m.size, m.width, m.height, m.alt, m.createdAt)
    .run();
  await bumpVersion(ctx);
  return toRecord((await findRow(ctx, id))!);
}

const badUrl = (url: string, hint: string) => new FemtoError("bad_request", `URL を取り込めません: ${url}`, { hint });

/** Reads at most MAX_MEDIA_BYTES from the body; stops pulling as soon as the cap is exceeded. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Fetches an http(s) URL (follows redirects, 20MB cap). Throws bad_request / payload_too_large. */
export async function fetchRemoteMedia(rawUrl: string): Promise<{ bytes: Uint8Array; contentType: string | null; url: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badUrl(rawUrl, "http:// または https:// で始まる URL を指定してください");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badUrl(rawUrl, "http:// または https:// の URL のみ取り込めます");
  }

  let res: Response;
  try {
    res = await fetch(url.href, { redirect: "follow" });
  } catch (e) {
    throw badUrl(rawUrl, `取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw badUrl(rawUrl, `取得先が HTTP ${res.status} を返しました`);
  }
  return { bytes: await readCapped(res), contentType: normalizeMime(res.headers.get("content-type")), url };
}

export async function importMediaFromUrl(
  ctx: Ctx, input: { url: string; filename?: string; alt?: string },
): Promise<MediaRecord> {
  requireRole(ctx, "admin");
  const { bytes, contentType, url } = await fetchRemoteMedia(input.url);
  let filename = input.filename;
  if (filename === undefined) {
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    try { filename = decodeURIComponent(last); } catch { filename = last; }
  }
  return uploadMedia(ctx, { bytes, filename, alt: input.alt, mimeType: contentType ?? undefined });
}

export async function uploadMediaBase64(
  ctx: Ctx, input: { base64: string; filename: string; mimeType?: string; alt?: string },
): Promise<MediaRecord> {
  requireRole(ctx, "admin");
  let b64 = input.base64.replace(/\s+/g, "");
  let mimeType = input.mimeType;
  const data = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(b64);
  if (data) {
    mimeType ??= data[1];
    b64 = b64.slice(data[0].length);
  }
  const invalid = () =>
    new FemtoError("bad_request", "base64 が不正です", { hint: "標準の base64（A-Z a-z 0-9 + /）で指定してください" });
  // Cheap character check first; atob below is the authority on padding and length (it throws on "AA=", "A==", ...).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw invalid();
  if ((b64.length * 3) / 4 > MAX_MEDIA_BYTES + 3) throw tooLarge(); // before decoding, so a huge string is not expanded
  let raw: string;
  try {
    raw = atob(b64);
  } catch {
    throw invalid();
  }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return uploadMedia(ctx, { bytes, filename: input.filename, mimeType, alt: input.alt });
}

export async function getMediaRecord(ctx: Ctx, id: string): Promise<MediaRecord> {
  requireRole(ctx, "admin");
  const row = await findRow(ctx, id);
  if (!row) throw new FemtoError("not_found", `メディア "${id}" が見つかりません`, { hint: "list_media で一覧を確認してください" });
  return toRecord(row);
}

export async function updateMedia(ctx: Ctx, id: string, patch: { alt?: string }): Promise<MediaRecord> {
  const current = await getMediaRecord(ctx, id); // checks role and existence
  if (patch.alt === undefined) return current;
  await ctx.db.prepare("UPDATE media SET alt = ? WHERE id = ? AND deleted_at IS NULL").bind(patch.alt, id).run();
  await bumpVersion(ctx);
  return { ...current, alt: patch.alt };
}

export async function listMedia(
  ctx: Ctx, params: { limit?: number; offset?: number },
): Promise<{ items: MediaRecord[]; total: number; limit: number; offset: number }> {
  requireRole(ctx, "admin");
  const clamp = (v: number | undefined, fallback: number, min: number, max: number) =>
    v === undefined || !Number.isFinite(v) ? fallback : Math.min(max, Math.max(min, Math.floor(v)));
  const limit = clamp(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const [page, count] = await ctx.db.batch([
    ctx.db
      .prepare("SELECT * FROM media WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
      .bind(limit, offset),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE deleted_at IS NULL"),
  ]);
  return {
    items: (page.results as MediaRow[]).map(toRecord),
    total: (count.results[0] as { n: number }).n,
    limit,
    offset,
  };
}

// Types that cannot run script on the CMS origin. Everything else (SVG, HTML, JS, ...) is forced to download.
const INLINE_SAFE = /^(image\/(?!svg\+xml$)[^/]+|application\/pdf|video\/[^/]+|audio\/[^/]+|text\/plain)$/;

// RFC 5987 attr-char: encodeURIComponent leaves ' ( ) * unescaped, which are not allowed.
const encodeRfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const notFound = () =>
  Response.json({ error: { code: "not_found", message: "メディアが見つかりません" } }, { status: 404 });

/** Public delivery (no role check). Trashed or missing media is a 404. */
export async function serveMedia(ctx: Ctx, id: string): Promise<Response> {
  const row = await findRow(ctx, id);
  if (!row) return notFound();
  const object = await ctx.bucket.get(r2Key(id));
  if (!object) return notFound();
  const inline = INLINE_SAFE.test(row.mime_type);
  return new Response(object.body, {
    headers: {
      "Content-Type": inline ? row.mime_type : GENERIC_MIME,
      "Content-Length": String(object.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeRfc5987(row.filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
