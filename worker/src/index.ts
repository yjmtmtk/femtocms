import { Hono } from "hono";
import { createCtx } from "./core/context";
import { serveMedia } from "./core/media";
import type { Env } from "./env";
import { VERSION } from "./version";

export const app = new Hono<{ Bindings: Env }>();

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

export default { fetch: app.fetch };
