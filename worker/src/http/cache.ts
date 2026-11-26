import type { Context } from "hono";
import { getSetting, type Ctx } from "../core/context";
import type { AuthEnv } from "./auth";

const PUBLIC_CACHE_CONTROL = "public, max-age=60";
const PRIVATE_CACHE_CONTROL = "private, no-store";
const VERSION_PARAM = "fcms-v";

async function weakEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `W/"${hex}"`;
}

/** Weak comparison (RFC 9110): `*` matches anything, otherwise any listed tag equal to ours ignoring the `W/` prefix. */
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || strip(t) === strip(etag));
}

function jsonResponse(body: string, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json; charset=UTF-8", ...headers } });
}

function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": PUBLIC_CACHE_CONTROL } });
}

function runInBackground(c: Context<AuthEnv>, task: Promise<unknown>): Promise<unknown> | void {
  const safe = task.catch((err) => console.error("edge cache put failed", err));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No ExecutionContext (e.g. app.request in tests): fall back to awaiting it.
    return safe;
  }
}

/**
 * Builds the JSON response for a read.
 * - public caller: `Cache-Control: public, max-age=60`, weak ETag + 304, and (off *.workers.dev) a Cache API entry
 *   whose key carries `content_version`, so every write makes old entries unreachable.
 * - keyed caller (read/admin) or a `?preview=` request: `private, no-store`, never stored. The Cache API ignores
 *   Authorization, which is why only role=public responses are ever put or matched.
 * Only the body and core headers are stored; CORS headers are added by the middleware around the returned response.
 */
export async function withPublicCache(c: Context<AuthEnv>, ctx: Ctx, compute: () => Promise<unknown>): Promise<Response> {
  const url = new URL(c.req.url);
  if (ctx.role !== "public" || url.searchParams.has("preview")) {
    return jsonResponse(JSON.stringify(await compute()), { "Cache-Control": PRIVATE_CACHE_CONTROL });
  }

  const ifNoneMatch = c.req.header("If-None-Match");
  // The Cache API needs a real (non-workers.dev) zone; there it is a no-op at best.
  const useEdge = !url.hostname.endsWith(".workers.dev") && typeof caches !== "undefined";
  let cache: Cache | undefined;
  let cacheKey: Request | undefined;
  if (useEdge) {
    // Version is read before computing: a write racing in between leaves stale data under the OLD key only.
    const version = (await getSetting(ctx, "content_version")) ?? "0";
    const keyUrl = new URL(url);
    keyUrl.searchParams.set(VERSION_PARAM, version);
    cache = caches.default;
    cacheKey = new Request(keyUrl.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) {
      const etag = hit.headers.get("ETag");
      if (etag && etagMatches(ifNoneMatch, etag)) return notModified(etag);
      return jsonResponse(await hit.text(), { ETag: etag ?? "", "Cache-Control": PUBLIC_CACHE_CONTROL });
    }
  }

  const body = JSON.stringify(await compute());
  const etag = await weakEtag(body);
  if (cache && cacheKey) {
    const pending = runInBackground(c, cache.put(cacheKey, jsonResponse(body, { ETag: etag, "Cache-Control": PUBLIC_CACHE_CONTROL })));
    if (pending) await pending;
  }
  if (etagMatches(ifNoneMatch, etag)) return notModified(etag);
  return jsonResponse(body, { ETag: etag, "Cache-Control": PUBLIC_CACHE_CONTROL });
}
