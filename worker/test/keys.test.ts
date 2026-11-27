import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCtx } from "../src/core/context";
import { bootstrapSql, generateKey, hashKey } from "../src/core/key-format";
import { createKey, listKeys, resolveRole, revokeKey } from "../src/core/keys";
import { FemtoError } from "../src/core/errors";
import { authMiddleware, type AuthEnv } from "../src/http/auth";

const admin = () => createCtx(env, "https://cms.test", "admin");
const reader = () => createCtx(env, "https://cms.test", "read");
const pub = () => createCtx(env, "https://cms.test", "public");
const KEY = "fcms_admin_" + "a".repeat(32);
const NOW = "2026-11-26T00:00:00.000Z";
const dbKey = (id: string) => env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first<Record<string, unknown>>();

describe("key-format", () => {
  it("generateKey gives a prefix + 32 alphanumeric characters", () => {
    expect(generateKey("admin")).toMatch(/^fcms_admin_[0-9a-zA-Z]{32}$/);
    expect(generateKey("read")).toMatch(/^fcms_read_[0-9a-zA-Z]{32}$/);
    expect(generateKey("admin")).not.toBe(generateKey("admin"));
  });
  it("generateKey uses all 62 characters (unbiased sampling)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const ch of generateKey("read").slice("fcms_read_".length)) seen.add(ch);
    expect(seen.size).toBe(62);
  });
  it("hashKey is the SHA-256 hex (known vector)", async () => {
    expect(await hashKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("bootstrapSql is a one-line INSERT and does not contain the plain key", async () => {
    const sql = await bootstrapSql(KEY, "init", NOW);
    expect(sql).not.toContain("\n");
    expect(sql).not.toContain(KEY);
    expect(sql).toContain(await hashKey(KEY));
    expect(sql).toContain(`'${KEY.slice(0, 16)}'`);
  });
  it("bootstrapSql escapes single quotes in name (no SQL injection)", async () => {
    const evil = "x'); DROP TABLE api_keys; --";
    await env.DB.exec(await bootstrapSql(KEY, evil, NOW));
    const rows = await env.DB.prepare("SELECT name, role, prefix, created_at FROM api_keys").all();
    expect(rows.results).toEqual([{ name: evil, role: "admin", prefix: KEY.slice(0, 16), created_at: NOW }]);
  });
  it("bootstrapSql rejects a name with line breaks or control characters, an empty name and a too long name", async () => {
    for (const bad of ["a\nb", "a\rb", "a\0b", "a\tb", "a\u2028b", "", "   ", "x".repeat(101)]) {
      await expect(bootstrapSql(KEY, bad, NOW)).rejects.toThrow();
    }
  });
  it("bootstrapSql rejects a key in an invalid format", async () => {
    await expect(bootstrapSql("fcms_read_" + "a".repeat(32), "n", NOW)).rejects.toThrow();
    await expect(bootstrapSql("x'; --", "n", NOW)).rejects.toThrow();
  });
});

describe("createKey / listKeys / revokeKey", () => {
  it("a created key resolves to admin", async () => {
    const { key, info } = await createKey(admin(), { name: "ci", role: "admin" });
    expect(key).toMatch(/^fcms_admin_[0-9a-zA-Z]{32}$/);
    expect(info.prefix).toBe(key.slice(0, 16));
    expect(info).toMatchObject({ name: "ci", role: "admin", lastUsedAt: null, revokedAt: null });
    expect(await resolveRole(env, `Bearer ${key}`)).toBe("admin");
  });
  it("a read key resolves to read", async () => {
    const { key } = await createKey(admin(), { name: "site", role: "read" });
    expect(key).toMatch(/^fcms_read_/);
    expect(await resolveRole(env, `Bearer ${key}`)).toBe("read");
  });
  it("the DB stores only the hash, not the plain key", async () => {
    const { key, info } = await createKey(admin(), { name: "ci", role: "admin" });
    const row = await dbKey(info.id);
    expect(row!.hash).toBe(await hashKey(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(info.id).toMatch(/^k_[0-9a-z]{12}$/);
  });
  it("name is trimmed; empty, 101 characters and control characters give validation_failed", async () => {
    const { info } = await createKey(admin(), { name: "  ci  ", role: "read" });
    expect(info.name).toBe("ci");
    for (const name of ["", "   ", "x".repeat(101), "a\nb", "a\0b"]) {
      await expect(createKey(admin(), { name, role: "read" })).rejects.toMatchObject({ code: "validation_failed" });
    }
    await createKey(admin(), { name: "x".repeat(100), role: "read" });
  });
  it("an invalid role or a wrong name type gives validation_failed", async () => {
    await expect(createKey(admin(), { name: "a", role: "root" as never })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(createKey(admin(), { name: 1 as never, role: "read" })).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("admin operations need admin (read gets forbidden, public gets unauthorized)", async () => {
    const { info } = await createKey(admin(), { name: "a", role: "admin" });
    await createKey(admin(), { name: "b", role: "admin" });
    for (const ctx of [reader(), pub()]) {
      const code = ctx.role === "public" ? "unauthorized" : "forbidden";
      await expect(createKey(ctx, { name: "x", role: "read" })).rejects.toMatchObject({ code });
      await expect(listKeys(ctx)).rejects.toMatchObject({ code });
      await expect(revokeKey(ctx, info.id)).rejects.toMatchObject({ code });
    }
  });
  it("listKeys is newest first, includes revoked keys, and contains neither the hash nor the plain key", async () => {
    const a = await createKey(admin(), { name: "a", role: "admin" });
    const b = await createKey(admin(), { name: "b", role: "admin" });
    const c = await createKey(admin(), { name: "c", role: "read" });
    await revokeKey(admin(), a.info.id);
    const list = await listKeys(admin());
    expect(list.map((k) => k.name)).toEqual(["c", "b", "a"]);
    expect(list[2]!.revokedAt).not.toBeNull();
    const json = JSON.stringify(list);
    for (const k of [a.key, b.key, c.key]) expect(json).not.toContain(k);
    expect(json).not.toContain(await hashKey(a.key));
  });
  it("a revoked key is unauthorized", async () => {
    await createKey(admin(), { name: "a", role: "admin" });
    const { key, info } = await createKey(admin(), { name: "b", role: "admin" });
    const revoked = await revokeKey(admin(), info.id);
    expect(revoked.revokedAt).not.toBeNull();
    await expect(resolveRole(env, `Bearer ${key}`)).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("revoke is idempotent (the second call changes nothing and returns the same info)", async () => {
    await createKey(admin(), { name: "a", role: "admin" });
    const { info } = await createKey(admin(), { name: "b", role: "read" });
    const first = await revokeKey(admin(), info.id);
    const second = await revokeKey(admin(), info.id);
    expect(second).toEqual(first);
  });
  it("an unknown id gives not_found", async () => {
    await expect(revokeKey(admin(), "k_nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("the last admin key cannot be revoked", async () => {
    const { info } = await createKey(admin(), { name: "only", role: "admin" });
    const err = await revokeKey(admin(), info.id).catch((e) => e);
    expect(err).toBeInstanceOf(FemtoError);
    expect(err).toMatchObject({ code: "conflict" });
    expect(err.hint).toContain("another admin key");
    expect((await dbKey(info.id))!.revoked_at).toBeNull();
  });
  it("another admin key can be revoked while an admin key remains, and the last admin is protected even if only read keys exist", async () => {
    const a = await createKey(admin(), { name: "a", role: "admin" });
    const b = await createKey(admin(), { name: "b", role: "admin" });
    await createKey(admin(), { name: "r", role: "read" });
    await revokeKey(admin(), a.info.id);
    await expect(revokeKey(admin(), b.info.id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("a read key can be revoked even when it is not the last admin", async () => {
    await createKey(admin(), { name: "a", role: "admin" });
    const r = await createKey(admin(), { name: "r", role: "read" });
    expect((await revokeKey(admin(), r.info.id)).revokedAt).not.toBeNull();
  });
  it("revoking two admin keys at the same time always leaves one", async () => {
    const a = await createKey(admin(), { name: "a", role: "admin" });
    const b = await createKey(admin(), { name: "b", role: "admin" });
    const results = await Promise.allSettled([revokeKey(admin(), a.info.id), revokeKey(admin(), b.info.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listKeys(admin())).filter((k) => !k.revokedAt)).toHaveLength(1);
  });
});

describe("resolveRole", () => {
  it("a key inserted with bootstrapSql works", async () => {
    await env.DB.exec(await bootstrapSql("fcms_admin_" + "a".repeat(32), "init", NOW));
    expect(await resolveRole(env, "Bearer fcms_admin_" + "a".repeat(32))).toBe("admin");
  });
  it("no header means public", async () => expect(await resolveRole(env, null)).toBe("public"));
  it("the scheme is case-insensitive", async () => {
    const { key } = await createKey(admin(), { name: "a", role: "admin" });
    expect(await resolveRole(env, `bearer ${key}`)).toBe("admin");
    expect(await resolveRole(env, `BEARER ${key}`)).toBe("admin");
  });
  it("a non-Bearer scheme, a malformed key and an unknown key are unauthorized", async () => {
    const { key } = await createKey(admin(), { name: "a", role: "admin" });
    for (const h of [
      "", key, `Basic ${key}`, `Token ${key}`, "Bearer", "Bearer ", `Bearer  ${key} extra`, `Bearer ${key} extra`,
      "Bearer garbage", `Bearer ${key.slice(0, -1)}`, `Bearer ${key}x`, `Bearer fcms_admin_${"b".repeat(32)}`,
    ]) {
      await expect(resolveRole(env, h)).rejects.toMatchObject({ code: "unauthorized" });
    }
  });
  it("the error does not contain the token", async () => {
    const bad = `fcms_admin_${"z".repeat(32)}`;
    const err = await resolveRole(env, `Bearer ${bad}`).catch((e) => e);
    expect(JSON.stringify({ m: err.message, h: err.hint })).not.toContain(bad);
  });
  it("with waitUntil, last_used_at is updated (not awaited)", async () => {
    const { key, info } = await createKey(admin(), { name: "a", role: "admin" });
    const pending: Promise<unknown>[] = [];
    await resolveRole(env, `Bearer ${key}`, (p) => pending.push(p));
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const used = (await dbKey(info.id))!.last_used_at as string;
    expect(used).toMatch(/^\d{4}-\d\d-\d\dT/);
    // within a minute: no second write is scheduled
    const pending2: Promise<unknown>[] = [];
    await resolveRole(env, `Bearer ${key}`, (p) => pending2.push(p));
    expect(pending2).toHaveLength(0);
    expect((await dbKey(info.id))!.last_used_at).toBe(used);
  });
  it("without waitUntil, last_used_at is not updated", async () => {
    const { key, info } = await createKey(admin(), { name: "a", role: "admin" });
    await resolveRole(env, `Bearer ${key}`);
    expect((await dbKey(info.id))!.last_used_at).toBeNull();
  });
});

describe("authMiddleware", () => {
  const build = () => {
    const app = new Hono<AuthEnv>();
    app.onError((e, c) => (e instanceof FemtoError ? c.json({ error: { code: e.code } }, e.status as 401) : c.json({ error: "boom" }, 500)));
    app.use("*", authMiddleware);
    app.get("/who", (c) => {
      const ctx = c.get("ctx");
      return c.json({ role: ctx.role, origin: ctx.origin, site: ctx.siteName });
    });
    return app;
  };
  it("no header means public, and the origin is taken from the URL (works without executionCtx)", async () => {
    const res = await build().request("https://cms.test/who", {}, env);
    expect(await res.json()).toEqual({ role: "public", origin: "https://cms.test", site: env.SITE_NAME });
  });
  it("a valid key gives admin / read", async () => {
    const a = await createKey(admin(), { name: "a", role: "admin" });
    const r = await createKey(admin(), { name: "r", role: "read" });
    const app = build();
    const get = async (k: string) => (await (await app.request("https://cms.test/who", { headers: { Authorization: `Bearer ${k}` } }, env)).json()) as { role: string };
    expect((await get(a.key)).role).toBe("admin");
    expect((await get(r.key)).role).toBe("read");
  });
  it("an invalid key gives 401", async () => {
    const res = await build().request("https://cms.test/who", { headers: { Authorization: "Bearer nope" } }, env);
    expect(res.status).toBe(401);
  });
  it("with executionCtx, last_used_at is updated through waitUntil", async () => {
    const { key, info } = await createKey(admin(), { name: "a", role: "admin" });
    const pending: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    await build().fetch(new Request("https://cms.test/who", { headers: { Authorization: `Bearer ${key}` } }), env, exec);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect((await dbKey(info.id))!.last_used_at).not.toBeNull();
  });
});
