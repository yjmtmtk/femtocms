import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type Profile } from "../src/config";
import { buildProgram } from "../src/index";
import { runDestroy, runInit, runUpgrade, type Prompter } from "../src/commands/deploy";
import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, packageRoot, siteConfigPath, writeSiteConfig } from "../src/deploy/site-config";
import {
  defaultRunner, findWorkersDevUrl, parseBucketNames, parseDatabaseId, type RunResult, type WranglerRunner,
} from "../src/deploy/wrangler";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

type Reply = RunResult | RunResult[];
interface Call {
  args: string[]; interactive?: boolean; env?: Record<string, string>; cwd?: string;
  /** The --config file as it was when the call was made (undefined if the call had no --config or the file was missing). */
  configAtCall?: Record<string, unknown>;
}

function readConfigAt(args: string[]): Record<string, unknown> | undefined {
  const i = args.indexOf("--config");
  if (i === -1) return undefined;
  try {
    return JSON.parse(readFileSync(args[i + 1]!, "utf8"));
  } catch {
    return undefined;
  }
}

/** Replies are chosen by the longest key that prefixes the space-joined args. An array is consumed one reply per call (the last one repeats). */
function fakeRunner(replies: Record<string, Reply>) {
  const calls: Call[] = [];
  const used = new Map<string, number>();
  const run: WranglerRunner = async (args, opts) => {
    calls.push({ args, interactive: opts?.interactive, env: opts?.env, cwd: opts?.cwd, configAtCall: readConfigAt(args) });
    const joined = args.join(" ");
    const key = Object.keys(replies).filter((k) => joined.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unexpected wrangler call: ${joined}`);
    const reply = replies[key]!;
    if (!Array.isArray(reply)) return reply;
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return reply[Math.min(n, reply.length - 1)]!;
  };
  return { run, calls, names: () => calls.map((c) => c.args.slice(0, 2).join(" ")), has: (prefix: string) => calls.some((c) => c.args.join(" ").startsWith(prefix)) };
}

function fakePrompt(opts: { texts?: string[]; select?: unknown; confirm?: boolean } = {}) {
  const texts = [...(opts.texts ?? [])];
  const log = { enters: [] as string[], selects: [] as string[], texts: [] as string[] };
  const prompt: Prompter = {
    confirm: async () => opts.confirm ?? true,
    text: async (m) => (log.texts.push(m), texts.shift() ?? ""),
    select: async <T,>(m: string, options: { value: T; label: string }[]) => {
      log.selects.push(m);
      return (opts.select ?? options[0]!.value) as T;
    },
    waitEnter: async (m) => void log.enters.push(m),
  };
  return { prompt, log };
}

const happy = (extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  "whoami --json": ok(JSON.stringify({ loggedIn: true, accounts: [{ id: "acc1", name: "me" }] })),
  "d1 list --json": ok("[]"),
  "d1 create femtocms-femtocms": ok('"database_id": "db-123"'),
  "r2 bucket list": ok(""),
  "r2 bucket create femtocms-femtocms": ok(""),
  deploy: ok("Deployed femtocms triggers\n  https://femtocms.me.workers.dev"),
  "d1 migrations": ok(),
  "d1 execute": ok(),
  ...extra,
});

let tmp: string;
let savedXdg: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "femtocms-deploy-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(tmp, { recursive: true, force: true });
});

const KEY = "fcms_admin_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const SITE = { workerName: "femtocms", d1Name: "femtocms-femtocms", d1Id: "db-123", bucket: "femtocms-femtocms", accountId: "acc1" };

function seedProfile(profile: Partial<Profile> = {}, name = "femtocms") {
  saveConfig({ current: name, profiles: { [name]: { url: "https://femtocms.me.workers.dev", key: KEY, site: SITE, ...profile } } });
}

/** A fetch that answers GET /api/keys with the given status and records every call. */
function fakeFetch(status = 200, kind: "femtocms" | "host" | "network" = "femtocms") {
  const calls: { method: string; url: string }[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    if (kind === "network") throw new TypeError("fetch failed");
    if (status === 200) return Response.json({ items: [] });
    // "host": the platform's own page (a deleted Worker's workers.dev URL), not a femtocms JSON error
    if (kind === "host") return new Response("There is nothing here yet.", { status, headers: { "content-type": "text/html" } });
    return Response.json({ error: { code: "unauthorized", message: "no" } }, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("runInit", () => {
  it("新規 init は D1・R2 を作り、deploy・migrate・キー投入を順に行う", async () => {
    const r = fakeRunner(happy());
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: (s) => logs.push(s) });
    expect(out.url).toBe("https://femtocms.me.workers.dev");
    expect(out.mcpUrl).toBe("https://femtocms.me.workers.dev/mcp");
    expect(out.key).toMatch(/^fcms_admin_[0-9a-zA-Z]{32}$/);
    expect(r.names()).toEqual(expect.arrayContaining(["d1 create", "r2 bucket", "deploy --config", "d1 migrations", "d1 execute"]));
    // order: d1 → r2 → deploy → migrations → key
    const order = ["d1 create", "r2 bucket create", "deploy", "d1 migrations", "d1 execute"].map((p) => r.calls.findIndex((c) => c.args.join(" ").startsWith(p)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("全ての wrangler 呼び出しに選んだアカウントを環境変数で渡し、SQL はシェルを通さず 1 引数で渡す", async () => {
    const r = fakeRunner(happy());
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    for (const c of r.calls.filter((c) => c.args[0] !== "login" && c.args[0] !== "whoami")) expect(c.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acc1" });
    const exec = r.calls.find((c) => c.args[1] === "execute")!;
    const sql = exec.args[exec.args.indexOf("--command") + 1]!;
    expect(sql).toMatch(/^INSERT INTO api_keys \(id, name, role, hash, prefix, created_at\) VALUES \('k_/);
    expect(sql).not.toContain(out.key); // only the hash and the prefix are stored
    expect(exec.args).toContain("--remote");
    expect(exec.args[exec.args.indexOf("--config") + 1]).toMatch(/wrangler\.jsonc$/);
  });

  it("プロファイルを保存して current にし、表示に URL・キー・MCP・claude mcp add・埋め込みコードを含める", async () => {
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: fakeRunner(happy()).run, prompt: fakePrompt().prompt, log: (s) => logs.push(s) });
    expect(loadConfig()).toEqual({
      current: "femtocms",
      profiles: { femtocms: { url: out.url, key: out.key, site: { ...SITE, d1Id: "db-123" } } },
    });
    const text = logs.join("\n");
    expect(text).toContain(out.key);
    expect(text).toContain("この1回だけ");
    expect(text).toContain(`claude mcp add --transport http femtocms ${out.url}/mcp --header "Authorization: Bearer ${out.key}"`);
    expect(text).toContain('<div data-femtocms="news" data-limit="5"></div>');
    expect(text).toContain(`<script src="${out.url}/embed.js" defer></script>`);
    expect(text).toMatch(/サイト名.*--confirm.*: femtocms$/m);
  });

  it("要約のサイト名は --name の値", async () => {
    const logs: string[] = [];
    await runInit({ name: "blog", runner: fakeRunner({
      ...happy(), "d1 create femtocms-blog": ok('"database_id": "db-9"'), "r2 bucket create femtocms-blog": ok(""),
      deploy: ok("https://blog.me.workers.dev"),
    }).run, prompt: fakePrompt().prompt, log: (s) => logs.push(s) });
    expect(logs.join("\n")).toMatch(/サイト名.*: blog$/m);
  });

  it("showSummary:false ではキーを表示に出さない（--json 用）", async () => {
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: fakeRunner(happy()).run, prompt: fakePrompt().prompt, log: (s) => logs.push(s), showSummary: false });
    expect(logs.join("\n")).not.toContain(out.key);
  });

  it("2回目の init は既存の D1・R2 を再利用し、動くキーを作り直さない", async () => {
    seedProfile();
    const r = fakeRunner(happy({
      "d1 list --json": ok(JSON.stringify([{ uuid: "db-123", name: "femtocms-femtocms" }])),
      "r2 bucket list": ok("name:           femtocms-femtocms\ncreation_date:  2026-11-26T00:00:00.000Z\n"),
    }));
    const f = fakeFetch(200);
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: (s) => logs.push(s), fetch: f.fn });
    expect(out.key).toBe(KEY);
    expect(r.has("d1 create")).toBe(false);
    expect(r.has("r2 bucket create")).toBe(false);
    expect(r.has("d1 execute")).toBe(false);
    expect(r.has("deploy")).toBe(true);
    expect(r.has("d1 migrations apply")).toBe(true);
    expect(f.calls).toEqual([{ method: "GET", url: "https://femtocms.me.workers.dev/api/keys" }]);
    expect(logs.join("\n")).not.toContain("この1回だけ");
  });

  it("保存済みのキーが 401 なら使わず、新しいキーを作って投入する（古いキーは表示しない）", async () => {
    seedProfile();
    const r = fakeRunner(happy());
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: (s) => logs.push(s), fetch: fakeFetch(401).fn });
    expect(out.key).not.toBe(KEY);
    expect(r.has("d1 execute")).toBe(true);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(loadConfig().profiles.femtocms!.key).toBe(out.key);
  });

  it("R2 未有効なら案内 URL を出して Enter を待ち、再確認する", async () => {
    const r = fakeRunner(happy({
      "r2 bucket list": [bad("✘ [ERROR] A request to the Cloudflare API failed.\n  Please enable R2 through the Cloudflare Dashboard. [code: 10042]"), ok("")],
    }));
    const logs: string[] = [];
    const p = fakePrompt();
    await runInit({ name: "femtocms", runner: r.run, prompt: p.prompt, log: (s) => logs.push(s) });
    expect(logs.join("\n")).toContain("https://dash.cloudflare.com/acc1/r2/overview");
    expect(p.log.enters).toHaveLength(1);
    expect(r.calls.filter((c) => c.args.slice(0, 3).join(" ") === "r2 bucket list")).toHaveLength(2);
  });

  it("R2 未有効の判定はエラーコード 10042 だけでも働き、他のエラーはそのまま失敗にする", async () => {
    const r1 = fakeRunner(happy({ "r2 bucket list": [bad("[code: 10042]"), ok("")] }));
    const p = fakePrompt();
    await runInit({ name: "femtocms", runner: r1.run, prompt: p.prompt, log: () => {} });
    expect(p.log.enters).toHaveLength(1);

    const r2 = fakeRunner(happy({ "r2 bucket list": bad("network down") }));
    const p2 = fakePrompt();
    await expect(runInit({ name: "femtocms", runner: r2.run, prompt: p2.prompt, log: () => {} })).rejects.toThrow(/network down/);
    expect(p2.log.enters).toHaveLength(0);
  });

  it("未ログインなら wrangler login（対話）を実行してやり直す", async () => {
    const r = fakeRunner(happy({
      "whoami --json": [bad("Not logged in"), ok(JSON.stringify({ accounts: [{ id: "acc1", name: "me" }] }))],
      login: ok(),
    }));
    await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    const login = r.calls.find((c) => c.args[0] === "login")!;
    expect(login.interactive).toBe(true);
    expect(r.calls.filter((c) => c.args[0] === "whoami")).toHaveLength(2);
  });

  it("アカウントが複数なら選ばせ、選んだ ID を渡す", async () => {
    const r = fakeRunner(happy({
      "whoami --json": ok(JSON.stringify({ accounts: [{ id: "acc1", name: "one" }, { id: "acc2", name: "two" }] })),
    }));
    const p = fakePrompt({ select: "acc2" });
    await runInit({ name: "femtocms", runner: r.run, prompt: p.prompt, log: () => {} });
    expect(p.log.selects).toHaveLength(1);
    expect(r.calls.filter((c) => c.args[0] !== "whoami").every((c) => c.env?.CLOUDFLARE_ACCOUNT_ID === "acc2")).toBe(true);
    expect(loadConfig().profiles.femtocms!.site!.accountId).toBe("acc2");
  });

  it("--domain を付けずに再度 init しても、保存済みの domain を保つ", async () => {
    seedProfile({ url: "https://cms.example.com", site: { ...SITE, domain: "cms.example.com" } });
    const r = fakeRunner(happy({ deploy: ok("Deployed femtocms triggers\n  cms.example.com (custom domain)") }));
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {}, fetch: fakeFetch(200).fn });
    expect(out.url).toBe("https://cms.example.com");
    expect(loadConfig().profiles.femtocms!.site!.domain).toBe("cms.example.com");
    expect(r.calls.find((c) => c.args[0] === "deploy")!.configAtCall!.routes).toEqual([{ pattern: "cms.example.com", custom_domain: true }]);
  });

  it("r2 bucket create が already exists（code 10004）で失敗したら、作成済みとして再利用する", async () => {
    for (const stderr of ["✘ [ERROR] The bucket you tried to create already exists, and you own it. [code: 10004]", "[code: 10004]"]) {
      saveConfig({ profiles: {} }); // a fresh site each time
      const r = fakeRunner(happy({ "r2 bucket create femtocms-femtocms": bad(stderr) }));
      const logs: string[] = [];
      await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: (s) => logs.push(s) });
      expect(r.has("deploy")).toBe(true);
      expect(logs.join("\n")).toContain("再利用");
    }
  });

  it("--domain ではカスタムドメインの URL を使い、設定に routes を入れる", async () => {
    const r = fakeRunner(happy({ deploy: ok("Deployed femtocms triggers\n  femtocms.example.com (custom domain)") }));
    const out = await runInit({ name: "femtocms", domain: "cms.example.com", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expect(out.url).toBe("https://cms.example.com");
    expect(loadConfig().profiles.femtocms!.site!.domain).toBe("cms.example.com");
    const path = r.calls.find((c) => c.args[0] === "deploy")!.args[2]!;
    expect(JSON.parse(readFileSync(path, "utf8")).routes).toEqual([{ pattern: "cms.example.com", custom_domain: true }]);
  });

  it("deploy の出力に URL が無ければ出力の末尾付きでエラーにする", async () => {
    const r = fakeRunner(happy({ deploy: ok("Uploaded femtocms\nDone.") }));
    await expect(runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} })).rejects.toThrow(/URL.*Uploaded femtocms/s);
  });

  it("workers.dev のサブドメイン未登録で deploy が失敗したら、対話で登録してから再実行する", async () => {
    const r = fakeRunner(happy({
      deploy: [
        bad("You can either deploy your worker to one or more routes ..., or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/acc1/workers/onboarding"),
        ok(""),
        ok("https://femtocms.me.workers.dev"),
      ],
    }));
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expect(out.url).toBe("https://femtocms.me.workers.dev");
    expect(r.calls.filter((c) => c.args[0] === "deploy").map((c) => Boolean(c.interactive))).toEqual([false, true, false]);
  });

  it("d1 create の出力から ID が取れなければ d1 list で探す", async () => {
    const r = fakeRunner(happy({
      "d1 list --json": [ok("[]"), ok(JSON.stringify([{ uuid: "db-from-list", name: "femtocms-femtocms" }]))],
      "d1 create femtocms-femtocms": ok("✅ Successfully created DB"),
    }));
    await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expect(loadConfig().profiles.femtocms!.site!.d1Id).toBe("db-from-list");
  });

  it("--cors-origins は正規化して site に保存し、wrangler 設定の vars.CORS_ORIGINS に書く", async () => {
    const r = fakeRunner(happy());
    await runInit({ name: "femtocms", corsOrigins: " https://a.example , https://b.example:8443/ ", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expect(loadConfig().profiles.femtocms!.site!.corsOrigins).toBe("https://a.example,https://b.example:8443");
    const deployCall = r.calls.find((c) => c.args[0] === "deploy")!;
    expect(deployCall.configAtCall!.vars).toEqual({ SITE_NAME: "femtocms", CORS_ORIGINS: "https://a.example,https://b.example:8443" });
  });

  it("再度の init は --cors-origins が無ければ保存済みの値を保ち、空文字なら消す（すべてのオリジンを許可）", async () => {
    seedProfile({ site: { ...SITE, corsOrigins: "https://a.example" } });
    const r = fakeRunner(happy());
    await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {}, fetch: fakeFetch(200).fn });
    expect(loadConfig().profiles.femtocms!.site!.corsOrigins).toBe("https://a.example");
    expect(r.calls.find((c) => c.args[0] === "deploy")!.configAtCall!.vars).toMatchObject({ CORS_ORIGINS: "https://a.example" });

    const r2 = fakeRunner(happy());
    await runInit({ name: "femtocms", corsOrigins: "", runner: r2.run, prompt: fakePrompt().prompt, log: () => {}, fetch: fakeFetch(200).fn });
    expect(loadConfig().profiles.femtocms!.site).not.toHaveProperty("corsOrigins");
    expect(r2.calls.find((c) => c.args[0] === "deploy")!.configAtCall!.vars).toEqual({ SITE_NAME: "femtocms" });
  });

  it("オリジンとして読めない --cors-origins は wrangler を呼ぶ前に断る", async () => {
    for (const bad of ["example.com", "ftp://a.example", "https://a.example/path", "https://a.example?x=1", "*"]) {
      const r = fakeRunner(happy());
      await expect(runInit({ name: "femtocms", corsOrigins: bad, runner: r.run, prompt: fakePrompt().prompt, log: () => {} }), bad)
        .rejects.toThrow("--cors-origins");
      expect(r.calls).toHaveLength(0);
    }
  });

  it("使えないプロファイル名は wrangler を呼ぶ前に断る", async () => {
    const r = fakeRunner(happy());
    await expect(runInit({ name: "Bad Name", runner: r.run, prompt: fakePrompt().prompt, log: () => {} })).rejects.toThrow(/Bad Name/);
    expect(r.calls).toHaveLength(0);
  });
});

describe("runUpgrade", () => {
  it("保存済みの site から設定を作り直し、migrations apply を先に、そのあと deploy だけ行う", async () => {
    seedProfile();
    const r = fakeRunner({ deploy: ok("https://femtocms.me.workers.dev"), "d1 migrations": ok() });
    await runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} });
    expect(r.names()).toEqual(["d1 migrations", "deploy --config"]);
    expect(r.calls.every((c) => c.env?.CLOUDFLARE_ACCOUNT_ID === "acc1")).toBe(true);
    const migrate = r.calls[0]!.args;
    expect(migrate.slice(0, 5)).toEqual(["d1", "migrations", "apply", "femtocms-femtocms", "--remote"]);
    expect(existsSync(r.calls[1]!.args[2]!)).toBe(true);
  });

  it("deploy の出力に URL が無くても upgrade は成功し、保存済みの URL を返す", async () => {
    seedProfile();
    const r = fakeRunner({ deploy: ok("Uploaded femtocms\nDone."), "d1 migrations": ok() });
    expect(await runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} })).toEqual({ url: "https://femtocms.me.workers.dev" });
  });

  it("マイグレーションが失敗したら deploy しない", async () => {
    seedProfile();
    const r = fakeRunner({ deploy: ok("https://femtocms.me.workers.dev"), "d1 migrations": bad("boom") });
    await expect(runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} })).rejects.toThrow(/boom/);
    expect(r.has("deploy")).toBe(false);
  });

  it("--cors-origins を指定すれば保存して設定に書き、無ければ保存済みの値を使い、空文字なら消す", async () => {
    seedProfile({ site: { ...SITE, corsOrigins: "https://old.example" } });
    const replies = { deploy: ok("https://femtocms.me.workers.dev"), "d1 migrations": ok() };
    const kept = fakeRunner(replies);
    await runUpgrade({ profile: "femtocms", runner: kept.run, log: () => {} });
    expect(kept.calls.find((c) => c.args[0] === "deploy")!.configAtCall!.vars).toMatchObject({ CORS_ORIGINS: "https://old.example" });

    const changed = fakeRunner(replies);
    await runUpgrade({ profile: "femtocms", corsOrigins: "https://new.example", runner: changed.run, log: () => {} });
    expect(loadConfig().profiles.femtocms!.site!.corsOrigins).toBe("https://new.example");
    expect(changed.calls.find((c) => c.args[0] === "deploy")!.configAtCall!.vars).toMatchObject({ CORS_ORIGINS: "https://new.example" });

    const cleared = fakeRunner(replies);
    await runUpgrade({ profile: "femtocms", corsOrigins: "", runner: cleared.run, log: () => {} });
    expect(loadConfig().profiles.femtocms!.site).not.toHaveProperty("corsOrigins");
    expect(cleared.calls.find((c) => c.args[0] === "deploy")!.configAtCall!.vars).toEqual({ SITE_NAME: "femtocms" });
  });

  it("init で作ったプロファイルでなければ断る", async () => {
    saveConfig({ current: "x", profiles: { x: { url: "https://x.test", key: KEY } } });
    await expect(runUpgrade({ profile: "x", runner: fakeRunner({}).run, log: () => {} })).rejects.toThrow(/femtocms init/);
  });
});

describe("runDestroy", () => {
  const destroyReplies = {
    delete: ok("Successfully deleted femtocms"),
    "d1 delete": ok(),
    "r2 bucket delete": ok(),
  };

  it("名前が一致しないと何もしない", async () => {
    seedProfile();
    const r = fakeRunner(destroyReplies);
    const f = fakeFetch();
    const done = await runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["other"] }).prompt, log: () => {}, fetch: f.fn });
    expect(done).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect(loadConfig().profiles.femtocms).toBeDefined();
  });

  it("一致したら API で空にしてから R2・Worker・D1 の順に削除し、プロファイルと生成した設定を消す", async () => {
    seedProfile();
    const r = fakeRunner(destroyReplies);
    const f = fakeFetch();
    const done = await runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: f.fn });
    expect(done).toBe(true);
    expect(f.calls).toEqual([
      { method: "POST", url: "https://femtocms.me.workers.dev/api/reset" },
      { method: "DELETE", url: "https://femtocms.me.workers.dev/api/trash?confirm=femtocms" },
    ]);
    const cfg = siteConfigPath("femtocms");
    expect(r.calls.map((c) => c.args.join(" "))).toEqual([
      `r2 bucket delete femtocms-femtocms --config ${cfg}`,
      `delete --name femtocms --force --config ${cfg}`,
      `d1 delete femtocms-femtocms -y --config ${cfg}`,
    ]);
    expect(r.calls.every((c) => c.env?.CLOUDFLARE_ACCOUNT_ID === "acc1")).toBe(true);
    expect(loadConfig()).toEqual({ profiles: {} });
    expect(existsSync(cfg)).toBe(false);
  });

  it("サイトを空にする API が HTTP エラー（401/403/5xx/JSON エラー）なら、何も削除せずに止まる", async () => {
    for (const status of [401, 403, 500, 503]) {
      seedProfile();
      const r = fakeRunner(destroyReplies);
      await expect(
        runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: fakeFetch(status).fn }),
      ).rejects.toThrow(new RegExp(`HTTP ${status}.*何も削除していません.*femtocms login`, "s"));
      expect(r.calls).toHaveLength(0);
      expect(loadConfig().profiles.femtocms).toBeDefined();
    }
  });

  it("ホスト自身の 404（削除済みの Worker）や接続失敗なら、Worker が無いものとして続行する", async () => {
    for (const f of [fakeFetch(404, "host"), fakeFetch(200, "network")]) {
      seedProfile();
      const r = fakeRunner(destroyReplies);
      const logs: string[] = [];
      const done = await runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: (s) => logs.push(s), fetch: f.fn });
      expect(done).toBe(true);
      expect(r.calls).toHaveLength(3);
      expect(logs.join("\n")).toContain("既に無い");
      expect(loadConfig().profiles).toEqual({});
    }
  });

  it("既に無いリソースは、そのリソース固有の wrangler の答えのときだけ成功として扱う", async () => {
    seedProfile();
    const r = fakeRunner({
      "r2 bucket delete": bad("✘ [ERROR] The specified bucket does not exist. [code: 10006]"),
      delete: bad("✘ [ERROR] This Worker does not exist on your account. [code: 10007]"),
      "d1 delete": bad("✘ [ERROR] Couldn't find a D1 DB with name or binding 'femtocms-femtocms' in your config or the API."),
    });
    const done = await runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: fakeFetch().fn });
    expect(done).toBe(true);
    expect(r.calls).toHaveLength(3);
  });

  it("汎用の not found（別アカウントかもしれない）は成功扱いにせず、止まってプロファイルを残す", async () => {
    seedProfile();
    const r = fakeRunner({ ...destroyReplies, "r2 bucket delete": bad("✘ [ERROR] Not found") });
    await expect(
      runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: fakeFetch().fn }),
    ).rejects.toThrow(/Not found/);
    expect(loadConfig().profiles.femtocms).toBeDefined();
  });

  it("R2 の削除に失敗（空でない）したら Worker と D1 は削除せず、残ったオブジェクトの消し方を示してプロファイルを残す", async () => {
    for (const stderr of ["The bucket you tried to delete is not empty [code: 10008]", "✘ [ERROR] [code: 10008]"]) {
      seedProfile();
      const r = fakeRunner({ ...destroyReplies, "r2 bucket delete": bad(stderr) });
      const err = await runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: fakeFetch().fn })
        .then(() => null, (e: Error) => e);
      expect(err?.message).toContain("femtocms-femtocms");
      expect(err?.message).toContain("wrangler r2 object delete femtocms-femtocms/<key> --remote");
      expect(err?.message).toContain("https://dash.cloudflare.com/acc1/r2/default/buckets/femtocms-femtocms");
      expect(err?.message).toContain("femtocms destroy");
      expect(err?.message).toContain("10008"); // wrangler's own output is kept
      expect(r.names()).toEqual(["r2 bucket"]);
      expect(loadConfig().profiles.femtocms).toBeDefined();
    }
  });
});

describe("保存済みの Worker 名の再検証（設定ファイルを書き換えられても外のパスを消さない）", () => {
  it("upgrade と destroy は、名前として使えない workerName を wrangler を呼ぶ前・ファイルを消す前に断る", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    for (const workerName of ["../../outside", "Bad", ""]) {
      seedProfile({ site: { ...SITE, workerName } });
      const r = fakeRunner({ deploy: ok(), "d1 migrations": ok(), delete: ok(), "d1 delete": ok(), "r2 bucket delete": ok() });
      await expect(runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} }), workerName).rejects.toThrow(/使えません/);
      const f = fakeFetch();
      await expect(runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: [workerName] }).prompt, log: () => {}, fetch: f.fn }), workerName)
        .rejects.toThrow(/使えません/);
      expect(r.calls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(loadConfig().profiles.femtocms).toBeDefined();
    }
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});

describe("アカウントの固定（ユーザー自身の wrangler 設定に引きずられない）", () => {
  /** Every call except whoami/login must name our generated config and run in its directory. */
  function expectPinned(calls: Call[]) {
    const cfg = siteConfigPath("femtocms");
    const pinned = calls.filter((c) => c.args[0] !== "whoami" && c.args[0] !== "login");
    expect(pinned.length).toBeGreaterThan(0);
    for (const c of pinned) {
      expect(c.args.slice(-2), c.args.join(" ")).toEqual(["--config", cfg]);
      expect(c.cwd, c.args.join(" ")).toBe(join(tmp, "femtocms", "sites", "femtocms"));
    }
  }

  it("init: D1/R2 の最初の呼び出しの時点で account_id 入りの設定があり、全ての呼び出しがそれを --config と cwd で使う", async () => {
    const r = fakeRunner(happy());
    await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expectPinned(r.calls);
    const first = r.calls.find((c) => c.args[0] === "d1" && c.args[1] === "list")!;
    expect(first.configAtCall).toMatchObject({ account_id: "acc1", name: "femtocms" });
    for (const c of r.calls.filter((c) => c.args[0] !== "whoami")) expect(c.configAtCall?.account_id).toBe("acc1");
    // after d1 create the id is written into the config before deploy
    const deployCall = r.calls.find((c) => c.args[0] === "deploy")!;
    expect((deployCall.configAtCall!.d1_databases as { database_id: string }[])[0]!.database_id).toBe("db-123");
  });

  it("upgrade と destroy も同様", async () => {
    seedProfile();
    const up = fakeRunner({ deploy: ok("https://femtocms.me.workers.dev"), "d1 migrations": ok() });
    await runUpgrade({ profile: "femtocms", runner: up.run, log: () => {} });
    expectPinned(up.calls);

    const d = fakeRunner({ delete: ok(), "d1 delete": ok(), "r2 bucket delete": ok() });
    // the config is removed at the end, so check while it is used
    await runDestroy({ profile: "femtocms", runner: d.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: fakeFetch().fn });
    expectPinned(d.calls);
    for (const c of d.calls) expect(c.configAtCall?.account_id).toBe("acc1");
  });
});

describe("writeSiteConfig", () => {
  it("no_bundle・SITE_NAME・バインディング・絶対パスを含む素の JSON を書く", () => {
    const path = writeSiteConfig(SITE, tmp);
    expect(path).toBe(join(tmp, "femtocms", "wrangler.jsonc"));
    const cfg = JSON.parse(readFileSync(path, "utf8")); // no comments, so plain JSON.parse works
    expect(cfg).toEqual({
      name: "femtocms",
      account_id: "acc1",
      main: join(packageRoot(), "dist", "worker", "index.js"),
      no_bundle: true,
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: COMPATIBILITY_FLAGS,
      d1_databases: [{ binding: "DB", database_name: "femtocms-femtocms", database_id: "db-123", migrations_dir: join(packageRoot(), "worker", "migrations") }],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "femtocms-femtocms" }],
      vars: { SITE_NAME: "femtocms" },
    });
    expect(existsSync(cfg.d1_databases[0].migrations_dir)).toBe(true);
  });

  it("D1 の ID がまだ無いときは d1_databases を入れない", () => {
    const cfg = JSON.parse(readFileSync(writeSiteConfig({ ...SITE, d1Id: "" }, tmp), "utf8"));
    expect(cfg.d1_databases).toBeUndefined();
    expect(cfg.account_id).toBe("acc1");
  });

  it("corsOrigins があれば vars.CORS_ORIGINS を入れる", () => {
    const cfg = JSON.parse(readFileSync(writeSiteConfig({ ...SITE, corsOrigins: "https://a.example,https://b.example" }, tmp), "utf8"));
    expect(cfg.vars).toEqual({ SITE_NAME: "femtocms", CORS_ORIGINS: "https://a.example,https://b.example" });
  });

  it("domain があれば custom domain の routes を入れる", () => {
    const cfg = JSON.parse(readFileSync(writeSiteConfig({ ...SITE, domain: "cms.example.com" }, tmp), "utf8"));
    expect(cfg.routes).toEqual([{ pattern: "cms.example.com", custom_domain: true }]);
  });

  it("互換性の日付とフラグは開発用の worker/wrangler.jsonc と同じ（ずれたらここで気づく）", () => {
    const dev = JSON.parse(readFileSync(join(packageRoot(), "worker", "wrangler.jsonc"), "utf8"));
    expect(COMPATIBILITY_DATE).toBe(dev.compatibility_date);
    expect(COMPATIBILITY_FLAGS).toEqual(dev.compatibility_flags);
  });
});

describe("wrangler output parsing", () => {
  it("d1 create の出力（JSON / TOML / JSONC のどの形でも）から database_id を取る", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(parseDatabaseId(`{\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "x",\n      "database_id": "${id}"\n    }\n  ]\n}`)).toBe(id);
    expect(parseDatabaseId(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"\ndatabase_id = "${id}"\n`)).toBe(id);
    expect(parseDatabaseId("✅ Successfully created DB 'x'")).toBeUndefined();
  });

  it("r2 bucket list の name: 行からバケット名を取る", () => {
    expect(parseBucketNames("name:           a\ncreation_date:  2026-01-01\n\nname:           femtocms-x\ncreation_date:  2026-01-02\n")).toEqual(["a", "femtocms-x"]);
    expect(parseBucketNames("")).toEqual([]);
  });

  it("deploy の出力から workers.dev の URL を取る（Worker 名で始まるものを優先）", () => {
    expect(findWorkersDevUrl("Deployed w triggers\n  https://w.me.workers.dev\nCurrent Version ID: 1", "w")).toBe("https://w.me.workers.dev");
    expect(findWorkersDevUrl("see https://dash.example.workers.dev and https://w.me.workers.dev", "w")).toBe("https://w.me.workers.dev");
    expect(findWorkersDevUrl("nothing here", "w")).toBeUndefined();
  });
});

describe("defaultRunner", () => {
  it("同梱の wrangler を node で起動できる（アカウントには触れない）", async () => {
    const res = await defaultRunner(["--version"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/\d+\.\d+\.\d+/);
  }, 30_000);
});

describe("built worker bundle", () => {
  const built = join(packageRoot(), "dist", "worker", "index.js");
  // dist/ is a build artifact (npm run build:worker); the build script also fails loudly on its own.
  it.skipIf(!existsSync(built))("embed.client.js の中身が文字列として埋め込まれ、外部モジュールの import が残っていない", () => {
    const text = readFileSync(built, "utf8");
    const embed = readFileSync(join(packageRoot(), "worker", "src", "public", "embed.client.js"), "utf8");
    expect(text).toContain(JSON.stringify(embed));
    expect(text).not.toMatch(/from\s+"\.\/[^"]*\.client\.js"/);
  });
});

describe("commands", () => {
  it("init / upgrade / destroy を登録している", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["init", "upgrade", "destroy"]));
    const init = buildProgram().commands.find((c) => c.name() === "init")!;
    expect(init.options.map((o) => o.long)).toEqual(["--name", "--domain", "--cors-origins"]);
    const upgrade = buildProgram().commands.find((c) => c.name() === "upgrade")!;
    expect(upgrade.options.map((o) => o.long)).toEqual(["--cors-origins"]);
  });
});
