import { Hono, type Context } from "hono";
import { createCollection, getCollection, listCollections, updateCollection } from "../core/collections";
import { FemtoError, type Issue } from "../core/errors";
import {
  createEntry, getEntryRecord, getSingle, listEntryRecords, publishEntry, putSingle, unpublishEntry, updateEntry,
} from "../core/entries";
import { createKey, listKeys, revokeKey } from "../core/keys";
import { requireRole } from "../core/context";
import {
  importMediaFromUrl, listMedia, MAX_MEDIA_BYTES, updateMedia, uploadMedia, uploadMediaBase64,
} from "../core/media";
import { presentEntries, presentEntry, presentMedia } from "../core/present";
import { createPreviewUrl, MAX_PREVIEW_TTL_SECONDS, readEntryWithPreview } from "../core/preview";
import { parseListParams } from "../core/query";
import { deletePermanently, emptyTrash, listTrash, restoreFromTrash, trashCollection, trashEntry, trashMedia } from "../core/trash";
import type { Status } from "../core/types";
import type { AuthEnv } from "./auth";
import { errorResponse } from "./errors";

type C = Context<AuthEnv>;

const MEDIA_ID_RE = /^m_[0-9a-z]{12}$/;
// Multipart framing adds a little on top of the file itself.
const MULTIPART_OVERHEAD = 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function jsonObject(c: C): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FemtoError("bad_request", "リクエストボディが正しい JSON ではありません", {
      hint: 'JSON オブジェクトを送ってください (例: {"data":{...}}) 。Content-Type: application/json を付けてください',
    });
  }
  if (!isObject(body)) {
    throw new FemtoError("bad_request", "リクエストボディは JSON オブジェクトである必要があります", {
      hint: 'ルートは配列や文字列ではなく {"..."} の形にしてください',
    });
  }
  return body;
}

const invalid = (issues: Issue[]) => new FemtoError("validation_failed", "入力が不正です", { issues });

function optionalStatus(body: Record<string, unknown>): Status | undefined {
  const s = body.status;
  if (s === undefined) return undefined;
  if (s === "draft" || s === "published") return s;
  throw invalid([{ path: "status", message: 'status は "draft" か "published" です', expected: "draft | published", received: s }]);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  throw invalid([{ path: key, message: `${key} は文字列です`, expected: "string", received: v }]);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = optionalString(body, key);
  if (v === undefined) throw invalid([{ path: key, message: `${key} は必須です`, expected: "string" }]);
  return v;
}

function checkContentLength(c: C, extra = 0): void {
  const declared = Number(c.req.header("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES + extra) {
    throw new FemtoError("payload_too_large", `ファイルが大きすぎます (上限 ${MAX_MEDIA_BYTES / 1024 / 1024}MB)`);
  }
}

const query = (c: C) => new URL(c.req.url).searchParams;
const noContent = (c: C) => c.body(null, 204);

export const api = new Hono<AuthEnv>();

// --- collections -------------------------------------------------------------------------------

api.get("/collections", async (c) => c.json({ items: await listCollections(c.get("ctx")) }));
api.post("/collections", async (c) => c.json(await createCollection(c.get("ctx"), await jsonObject(c)), 201));
api.get("/collections/:name", async (c) => c.json(await getCollection(c.get("ctx"), c.req.param("name"))));
api.patch("/collections/:name", async (c) =>
  c.json(await updateCollection(c.get("ctx"), c.req.param("name"), await jsonObject(c))));
api.delete("/collections/:name", async (c) => {
  await trashCollection(c.get("ctx"), c.req.param("name"));
  return noContent(c);
});

// --- media -------------------------------------------------------------------------------------

api.get("/media", async (c) => {
  const ctx = c.get("ctx");
  const { limit, offset } = parseListParams(query(c));
  const page = await listMedia(ctx, { limit, offset });
  return c.json({ ...page, items: page.items.map((m) => presentMedia(ctx, m)) });
});

api.post("/media", async (c) => {
  const ctx = c.get("ctx");
  const type = c.req.header("Content-Type") ?? "";
  if (/^multipart\/form-data/i.test(type)) {
    checkContentLength(c, MULTIPART_OVERHEAD);
    const form = await c.req.formData();
    const file = form.get("file");
    if (typeof file === "string" || file === null) {
      throw new FemtoError("bad_request", 'multipart の "file" フィールドにファイルが必要です', {
        hint: "curl -F file=@image.png -F alt=説明 のように送ってください",
      });
    }
    const alt = form.get("alt");
    const media = await uploadMedia(ctx, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name || "upload",
      mimeType: file.type || undefined,
      alt: typeof alt === "string" ? alt : undefined,
    });
    return c.json(presentMedia(ctx, media), 201);
  }

  const body = await jsonObject(c);
  const alt = optionalString(body, "alt");
  const filename = optionalString(body, "filename");
  if (body.url !== undefined) {
    return c.json(presentMedia(ctx, await importMediaFromUrl(ctx, { url: requireString(body, "url"), filename, alt })), 201);
  }
  if (body.base64 !== undefined) {
    const media = await uploadMediaBase64(ctx, {
      base64: requireString(body, "base64"), filename: requireString(body, "filename"),
      mimeType: optionalString(body, "mimeType"), alt,
    });
    return c.json(presentMedia(ctx, media), 201);
  }
  throw new FemtoError("bad_request", "メディアの指定がありません", {
    hint: 'multipart (file)、JSON {"url"}、または JSON {"base64","filename"} のいずれかで送ってください',
  });
});

// Raw-body upload under a caller-chosen id (used by import to restore files with their original ids).
api.put("/media/:id", async (c) => {
  const ctx = c.get("ctx");
  const id = c.req.param("id");
  if (!MEDIA_ID_RE.test(id)) {
    throw new FemtoError("bad_request", `メディア id の形式が不正です: "${id}"`, { hint: "m_ + 英小文字と数字 12 文字 (例: m_0123456789ab)" });
  }
  const q = query(c);
  const filename = q.get("filename");
  if (!filename) throw new FemtoError("bad_request", "filename クエリが必要です", { hint: "PUT /api/media/<id>?filename=photo.png" });
  checkContentLength(c);
  const media = await uploadMedia(
    ctx,
    {
      bytes: new Uint8Array(await c.req.arrayBuffer()), filename,
      mimeType: c.req.header("Content-Type") ?? undefined, alt: q.get("alt") ?? undefined,
    },
    { id },
  );
  return c.json(presentMedia(ctx, media));
});

api.patch("/media/:id", async (c) => {
  const ctx = c.get("ctx");
  const body = await jsonObject(c);
  return c.json(presentMedia(ctx, await updateMedia(ctx, c.req.param("id"), { alt: optionalString(body, "alt") })));
});
api.delete("/media/:id", async (c) => {
  await trashMedia(c.get("ctx"), c.req.param("id"));
  return noContent(c);
});

// --- trash -------------------------------------------------------------------------------------

api.get("/trash", async (c) => c.json({ items: await listTrash(c.get("ctx")) }));
api.post("/trash/:id/restore", async (c) => c.json(await restoreFromTrash(c.get("ctx"), c.req.param("id"))));
api.delete("/trash/:id", async (c) => {
  await deletePermanently(c.get("ctx"), c.req.param("id"), query(c).get("confirm") ?? undefined);
  return noContent(c);
});
api.delete("/trash", async (c) => c.json(await emptyTrash(c.get("ctx"), query(c).get("confirm") ?? undefined)));

// --- keys --------------------------------------------------------------------------------------

api.get("/keys", async (c) => c.json({ items: await listKeys(c.get("ctx")) }));
api.post("/keys", async (c) => {
  const body = await jsonObject(c);
  return c.json(await createKey(c.get("ctx"), body as { name: string; role: "admin" | "read" }), 201);
});
api.delete("/keys/:id", async (c) => c.json(await revokeKey(c.get("ctx"), c.req.param("id"))));

// Later tasks register /export, /import, /reset and /openapi.json HERE, before the `/:c` routes below.

// --- entries (/:c must stay after every fixed route above) --------------------------------------

api.get("/:c", async (c) => {
  const ctx = c.get("ctx");
  const name = c.req.param("c");
  const params = parseListParams(query(c));
  const collection = await getCollection(ctx, name);
  const opts = { fields: params.fields, expand: params.expand };
  if (collection.kind === "single") {
    return c.json(await presentEntry(ctx, collection, await getSingle(ctx, name), opts));
  }
  const page = await listEntryRecords(ctx, name, params);
  return c.json({ ...page, items: await presentEntries(ctx, collection, page.items, opts) });
});

api.post("/:c", async (c) => {
  const ctx = c.get("ctx");
  const name = c.req.param("c");
  const body = await jsonObject(c);
  const status = optionalStatus(body);
  const record = await createEntry(ctx, name, {
    data: body.data, slug: body.slug as string | null | undefined, status, publishedAt: body.publishedAt as string | undefined,
  });
  return c.json(await presentEntry(ctx, await getCollection(ctx, name), record, {}), 201);
});

api.put("/:c", async (c) => {
  const ctx = c.get("ctx");
  const name = c.req.param("c");
  const body = await jsonObject(c);
  const status = optionalStatus(body);
  // putSingle checks the role and that the collection is single (list -> bad_request).
  const record = await putSingle(ctx, name, { data: body.data, status });
  return c.json(await presentEntry(ctx, await getCollection(ctx, name), record, {}));
});

api.get("/:c/:id", async (c) => {
  const ctx = c.get("ctx");
  const name = c.req.param("c");
  const params = parseListParams(query(c));
  const token = query(c).get("preview");
  if (token !== null) {
    // Anything that used a preview token is per-caller: never let a shared cache keep it.
    try {
      const entry = await readEntryWithPreview(ctx, name, c.req.param("id"), token, { fields: params.fields, expand: params.expand });
      c.header("Cache-Control", "private, no-store");
      return c.json(entry);
    } catch (err) {
      const res = errorResponse(err);
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
  }
  const record = await getEntryRecord(ctx, name, c.req.param("id"));
  return c.json(await presentEntry(ctx, await getCollection(ctx, name), record, { fields: params.fields, expand: params.expand }));
});

api.patch("/:c/:id", async (c) => {
  const ctx = c.get("ctx");
  const name = c.req.param("c");
  const body = await jsonObject(c);
  const record = await updateEntry(ctx, name, c.req.param("id"), {
    data: body.data, slug: body.slug as string | null | undefined, publishedAt: body.publishedAt as string | undefined,
  });
  return c.json(await presentEntry(ctx, await getCollection(ctx, name), record, {}));
});

api.delete("/:c/:id", async (c) => {
  await trashEntry(c.get("ctx"), c.req.param("c"), c.req.param("id"));
  return noContent(c);
});

for (const [action, run] of [["publish", publishEntry], ["unpublish", unpublishEntry]] as const) {
  api.post(`/:c/:id/${action}`, async (c) => {
    const ctx = c.get("ctx");
    const name = c.req.param("c");
    const record = await run(ctx, name, c.req.param("id"));
    return c.json(await presentEntry(ctx, await getCollection(ctx, name), record, {}));
  });
}

api.post("/:c/:id/preview", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "admin");
  const text = await c.req.text();
  const body = text.trim() === "" ? {} : await jsonObject(c);
  const ttl = body.ttlSeconds;
  if (ttl !== undefined && !(Number.isInteger(ttl) && (ttl as number) >= 1 && (ttl as number) <= MAX_PREVIEW_TTL_SECONDS)) {
    throw invalid([{
      path: "ttlSeconds", message: `ttlSeconds は 1〜${MAX_PREVIEW_TTL_SECONDS} の整数（秒）です`,
      expected: `integer 1..${MAX_PREVIEW_TTL_SECONDS}`, received: ttl,
    }]);
  }
  return c.json(await createPreviewUrl(ctx, c.req.param("c"), c.req.param("id"), { ttlSeconds: ttl as number | undefined }));
});
