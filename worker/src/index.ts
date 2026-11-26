import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { createCtx } from "./core/context";
import { FemtoError } from "./core/errors";
import { serveMedia } from "./core/media";
import { loadPreview } from "./core/preview";
import type { Env } from "./env";
import { authMiddleware } from "./http/auth";
import { errorResponse } from "./http/errors";
import { api } from "./http/routes";
import { renderPreviewPage } from "./public/preview-page";
import { VERSION } from "./version";

export const app = new Hono<{ Bindings: Env }>();

// CORS_ORIGINS is a comma-separated allow-list; unset means any origin.
const corsMiddleware: MiddlewareHandler<{ Bindings: Env }> = (c, next) => {
  const allowed = (c.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: allowed.length ? (origin) => (allowed.includes(origin) ? origin : null) : "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
  })(c, next);
};
app.use("/api/*", corsMiddleware);
app.use("/media/*", corsMiddleware);

app.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    name: "femtocms",
    site: c.env.SITE_NAME,
    version: VERSION,
    api: `${origin}/api`,
    mcp: `${origin}/mcp`,
    openapi: `${origin}/api/openapi.json`,
  });
});

// The filename segment is cosmetic (for humans and downloads); the id alone identifies the file.
app.get("/media/:id/:filename?", (c) => serveMedia(createCtx(c.env, new URL(c.req.url).origin, "public"), c.req.param("id")));

// Token-gated draft page: the token is the credential, so no auth middleware. Errors are plain text, never cached.
app.get("/preview/:token", async (c) => {
  try {
    const { collection, entry } = await loadPreview(createCtx(c.env, new URL(c.req.url).origin, "public"), c.req.param("token"));
    return new Response(renderPreviewPage(collection, entry), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex",
        "Content-Security-Policy": "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'",
      },
    });
  } catch (err) {
    if (!(err instanceof FemtoError)) throw err;
    return new Response(`${err.message}\n`, {
      status: err.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  }
});

app.use("/api/*", authMiddleware);
app.route("/api", api);

app.notFound(() => errorResponse(new FemtoError("not_found", "見つかりません", { hint: "GET /api/collections で利用可能なコレクションを確認してください" })));
app.onError((err) => errorResponse(err));

export default { fetch: app.fetch };
