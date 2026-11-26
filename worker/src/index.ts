import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { createCtx } from "./core/context";
import { FemtoError } from "./core/errors";
import { serveMedia } from "./core/media";
import type { Env } from "./env";
import { authMiddleware } from "./http/auth";
import { errorResponse } from "./http/errors";
import { api } from "./http/routes";
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

app.use("/api/*", authMiddleware);
app.route("/api", api);

app.notFound(() => errorResponse(new FemtoError("not_found", "見つかりません", { hint: "GET /api/collections で利用可能なコレクションを確認してください" })));
app.onError((err) => errorResponse(err));

export default { fetch: app.fetch };
