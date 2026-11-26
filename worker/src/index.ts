import { Hono } from "hono";
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

export default { fetch: app.fetch };
