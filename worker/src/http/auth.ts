import type { MiddlewareHandler } from "hono";
import { createCtx, type Ctx } from "../core/context";
import { resolveRole } from "../core/keys";
import type { Env } from "../env";

/** Hono generic for routes that sit behind `authMiddleware`. */
export type AuthEnv = { Bindings: Env; Variables: { ctx: Ctx } };

export const authMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
  // executionCtx is a throwing getter when the app is invoked without one (e.g. app.request in tests).
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const exec = c.executionCtx;
    waitUntil = (p) => exec.waitUntil(p);
  } catch {
    waitUntil = undefined;
  }
  const role = await resolveRole(c.env, c.req.header("Authorization") ?? null, waitUntil);
  c.set("ctx", createCtx(c.env, new URL(c.req.url).origin, role));
  await next();
};
