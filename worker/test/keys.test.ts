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
  it("generateKey は接頭辞 + 32 文字の英数字", () => {
    expect(generateKey("admin")).toMatch(/^fcms_admin_[0-9a-zA-Z]{32}$/);
    expect(generateKey("read")).toMatch(/^fcms_read_[0-9a-zA-Z]{32}$/);
    expect(generateKey("admin")).not.toBe(generateKey("admin"));
  });
  it("generateKey は 62 文字すべてを使う（偏りのない抽出）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const ch of generateKey("read").slice("fcms_read_".length)) seen.add(ch);
    expect(seen.size).toBe(62);
  });
  it("hashKey は SHA-256 の hex（既知ベクタ）", async () => {
    expect(await hashKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("bootstrapSql は 1 行の INSERT で、平文キーを含まない", async () => {
    const sql = await bootstrapSql(KEY, "init", NOW);
    expect(sql).not.toContain("\n");
    expect(sql).not.toContain(KEY);
    expect(sql).toContain(await hashKey(KEY));
    expect(sql).toContain(`'${KEY.slice(0, 16)}'`);
  });
  it("bootstrapSql は name の単引用符をエスケープする（SQL インジェクション不可）", async () => {
    const evil = "x'); DROP TABLE api_keys; --";
    await env.DB.exec(await bootstrapSql(KEY, evil, NOW));
    const rows = await env.DB.prepare("SELECT name, role, prefix, created_at FROM api_keys").all();
    expect(rows.results).toEqual([{ name: evil, role: "admin", prefix: KEY.slice(0, 16), created_at: NOW }]);
  });
  it("bootstrapSql は name の改行・制御文字・空・長すぎを拒否する", async () => {
    for (const bad of ["a\nb", "a\rb", "a\0b", "a\tb", "a\u2028b", "", "   ", "x".repeat(101)]) {
      await expect(bootstrapSql(KEY, bad, NOW)).rejects.toThrow();
    }
  });
  it("bootstrapSql は不正な形式のキーを拒否する", async () => {
    await expect(bootstrapSql("fcms_read_" + "a".repeat(32), "n", NOW)).rejects.toThrow();
    await expect(bootstrapSql("x'; --", "n", NOW)).rejects.toThrow();
  });
});

describe("createKey / listKeys / revokeKey", () => {
  it("作成したキーで admin に解決される", async () => {
    const { key, info } = await createKey(admin(), { name: "ci", role: "admin" });
    expect(key).toMatch(/^fcms_admin_[0-9a-zA-Z]{32}$/);
    expect(info.prefix).toBe(key.slice(0, 16));
    expect(info).toMatchObject({ name: "ci", role: "admin", lastUsedAt: null, revokedAt: null });
    expect(await resolveRole(env, `Bearer ${key}`)).toBe("admin");
  });
  it("read キーは read に解決される", async () => {
    const { key } = await createKey(admin(), { name: "site", role: "read" });
    expect(key).toMatch(/^fcms_read_/);
    expect(await resolveRole(env, `Bearer ${key}`)).toBe("read");
  });
  it("DB には平文でなくハッシュだけ保存される", async () => {
    const { key, info } = await createKey(admin(), { name: "ci", role: "admin" });
    const row = await dbKey(info.id);
    expect(row!.hash).toBe(await hashKey(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(info.id).toMatch(/^k_[0-9a-z]{12}$/);
  });
  it("name は trim され、空・101文字・制御文字は validation_failed", async () => {
    const { info } = await createKey(admin(), { name: "  ci  ", role: "read" });
    expect(info.name).toBe("ci");
    for (const name of ["", "   ", "x".repeat(101), "a\nb", "a\0b"]) {
      await expect(createKey(admin(), { name, role: "read" })).rejects.toMatchObject({ code: "validation_failed" });
    }
    await createKey(admin(), { name: "x".repeat(100), role: "read" });
  });
  it("不正な role や name の型は validation_failed", async () => {
    await expect(createKey(admin(), { name: "a", role: "root" as never })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(createKey(admin(), { name: 1 as never, role: "read" })).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("管理操作は admin のみ（read は forbidden、public は unauthorized）", async () => {
    const { info } = await createKey(admin(), { name: "a", role: "admin" });
    await createKey(admin(), { name: "b", role: "admin" });
    for (const ctx of [reader(), pub()]) {
      const code = ctx.role === "public" ? "unauthorized" : "forbidden";
      await expect(createKey(ctx, { name: "x", role: "read" })).rejects.toMatchObject({ code });
      await expect(listKeys(ctx)).rejects.toMatchObject({ code });
      await expect(revokeKey(ctx, info.id)).rejects.toMatchObject({ code });
    }
  });
  it("listKeys は新しい順で revoke 済みも含み、ハッシュも平文も含まない", async () => {
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
  it("revoke 済みのキーは unauthorized", async () => {
    await createKey(admin(), { name: "a", role: "admin" });
    const { key, info } = await createKey(admin(), { name: "b", role: "admin" });
    const revoked = await revokeKey(admin(), info.id);
    expect(revoked.revokedAt).not.toBeNull();
    await expect(resolveRole(env, `Bearer ${key}`)).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("revoke は冪等（2回目は変更せずに同じ情報を返す）", async () => {
    await createKey(admin(), { name: "a", role: "admin" });
    const { info } = await createKey(admin(), { name: "b", role: "read" });
    const first = await revokeKey(admin(), info.id);
    const second = await revokeKey(admin(), info.id);
    expect(second).toEqual(first);
  });
  it("存在しない id は not_found", async () => {
    await expect(revokeKey(admin(), "k_nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("最後の管理キーは revoke できない", async () => {
    const { info } = await createKey(admin(), { name: "only", role: "admin" });
    const err = await revokeKey(admin(), info.id).catch((e) => e);
    expect(err).toBeInstanceOf(FemtoError);
    expect(err).toMatchObject({ code: "conflict" });
    expect(err.hint).toContain("別の管理キー");
    expect((await dbKey(info.id))!.revoked_at).toBeNull();
  });
  it("管理キーが残っていれば他の管理キーは revoke でき、read キーしか無くても最後の admin は守られる", async () => {
    const a = await createKey(admin(), { name: "a", role: "admin" });
    const b = await createKey(admin(), { name: "b", role: "admin" });
    await createKey(admin(), { name: "r", role: "read" });
    await revokeKey(admin(), a.info.id);
    await expect(revokeKey(admin(), b.info.id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("read キーは最後の admin でなくても revoke できる", async () => {
    await createKey(admin(), { name: "a", role: "admin" });
    const r = await createKey(admin(), { name: "r", role: "read" });
    expect((await revokeKey(admin(), r.info.id)).revokedAt).not.toBeNull();
  });
  it("同時に 2 つの管理キーを revoke しても片方は必ず残る", async () => {
    const a = await createKey(admin(), { name: "a", role: "admin" });
    const b = await createKey(admin(), { name: "b", role: "admin" });
    const results = await Promise.allSettled([revokeKey(admin(), a.info.id), revokeKey(admin(), b.info.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listKeys(admin())).filter((k) => !k.revokedAt)).toHaveLength(1);
  });
});

describe("resolveRole", () => {
  it("bootstrapSql で入れたキーが使える", async () => {
    await env.DB.exec(await bootstrapSql("fcms_admin_" + "a".repeat(32), "init", NOW));
    expect(await resolveRole(env, "Bearer fcms_admin_" + "a".repeat(32))).toBe("admin");
  });
  it("ヘッダ無しは public", async () => expect(await resolveRole(env, null)).toBe("public"));
  it("scheme は大文字小文字を区別しない", async () => {
    const { key } = await createKey(admin(), { name: "a", role: "admin" });
    expect(await resolveRole(env, `bearer ${key}`)).toBe("admin");
    expect(await resolveRole(env, `BEARER ${key}`)).toBe("admin");
  });
  it("Bearer 以外・形式不正・未知のキーは unauthorized", async () => {
    const { key } = await createKey(admin(), { name: "a", role: "admin" });
    for (const h of [
      "", key, `Basic ${key}`, `Token ${key}`, "Bearer", "Bearer ", `Bearer  ${key} extra`, `Bearer ${key} extra`,
      "Bearer garbage", `Bearer ${key.slice(0, -1)}`, `Bearer ${key}x`, `Bearer fcms_admin_${"b".repeat(32)}`,
    ]) {
      await expect(resolveRole(env, h)).rejects.toMatchObject({ code: "unauthorized" });
    }
  });
  it("エラーにトークンが含まれない", async () => {
    const bad = `fcms_admin_${"z".repeat(32)}`;
    const err = await resolveRole(env, `Bearer ${bad}`).catch((e) => e);
    expect(JSON.stringify({ m: err.message, h: err.hint })).not.toContain(bad);
  });
  it("waitUntil があれば last_used_at を更新する（await しない）", async () => {
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
  it("waitUntil が無ければ last_used_at は更新しない", async () => {
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
  it("ヘッダ無しは public、origin は URL から取る（executionCtx が無くても動く）", async () => {
    const res = await build().request("https://cms.test/who", {}, env);
    expect(await res.json()).toEqual({ role: "public", origin: "https://cms.test", site: env.SITE_NAME });
  });
  it("有効なキーで admin / read", async () => {
    const a = await createKey(admin(), { name: "a", role: "admin" });
    const r = await createKey(admin(), { name: "r", role: "read" });
    const app = build();
    const get = async (k: string) => (await (await app.request("https://cms.test/who", { headers: { Authorization: `Bearer ${k}` } }, env)).json()) as { role: string };
    expect((await get(a.key)).role).toBe("admin");
    expect((await get(r.key)).role).toBe("read");
  });
  it("不正なキーは 401", async () => {
    const res = await build().request("https://cms.test/who", { headers: { Authorization: "Bearer nope" } }, env);
    expect(res.status).toBe(401);
  });
  it("executionCtx があれば waitUntil 経由で last_used_at が更新される", async () => {
    const { key, info } = await createKey(admin(), { name: "a", role: "admin" });
    const pending: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    await build().fetch(new Request("https://cms.test/who", { headers: { Authorization: `Bearer ${key}` } }), env, exec);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect((await dbKey(info.id))!.last_used_at).not.toBeNull();
  });
});
