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
  it("a fresh init creates the D1 database and R2 bucket, then deploys, migrates and inserts the key, in that order", async () => {
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

  it("passes the chosen account to every wrangler call through the environment, and passes the SQL as one argument without a shell", async () => {
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

  it("saves the profile and makes it current, and the summary includes the URL, key, MCP, claude mcp add and the embed code", async () => {
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: fakeRunner(happy()).run, prompt: fakePrompt().prompt, log: (s) => logs.push(s) });
    expect(loadConfig()).toEqual({
      current: "femtocms",
      profiles: { femtocms: { url: out.url, key: out.key, site: { ...SITE, d1Id: "db-123" } } },
    });
    const text = logs.join("\n");
    expect(text).toContain(out.key);
    expect(text).toContain("only this once");
    expect(text).toContain(`claude mcp add --transport http femtocms ${out.url}/mcp --header "Authorization: Bearer ${out.key}"`);
    expect(text).toContain('<div data-femtocms="news" data-limit="5"></div>');
    expect(text).toContain(`<script src="${out.url}/embed.js" defer></script>`);
    expect(text).toMatch(/Site name.*--confirm.*: femtocms$/m);
  });

  it("the site name in the summary is the --name value", async () => {
    const logs: string[] = [];
    await runInit({ name: "blog", runner: fakeRunner({
      ...happy(), "d1 create femtocms-blog": ok('"database_id": "db-9"'), "r2 bucket create femtocms-blog": ok(""),
      deploy: ok("https://blog.me.workers.dev"),
    }).run, prompt: fakePrompt().prompt, log: (s) => logs.push(s) });
    expect(logs.join("\n")).toMatch(/Site name.*: blog$/m);
  });

  it("showSummary:false does not print the key (for --json)", async () => {
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: fakeRunner(happy()).run, prompt: fakePrompt().prompt, log: (s) => logs.push(s), showSummary: false });
    expect(logs.join("\n")).not.toContain(out.key);
  });

  it("a second init reuses the existing D1 database and R2 bucket and does not recreate a working key", async () => {
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
    expect(logs.join("\n")).not.toContain("only this once");
  });

  it("when the saved key gets 401, it is not used: a new key is created and inserted (the old key is not printed)", async () => {
    seedProfile();
    const r = fakeRunner(happy());
    const logs: string[] = [];
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: (s) => logs.push(s), fetch: fakeFetch(401).fn });
    expect(out.key).not.toBe(KEY);
    expect(r.has("d1 execute")).toBe(true);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(loadConfig().profiles.femtocms!.key).toBe(out.key);
  });

  it("when R2 is not enabled, prints the URL to enable it, waits for Enter and checks again", async () => {
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

  it("R2-not-enabled is detected from error code 10042 alone, and other errors still fail", async () => {
    const r1 = fakeRunner(happy({ "r2 bucket list": [bad("[code: 10042]"), ok("")] }));
    const p = fakePrompt();
    await runInit({ name: "femtocms", runner: r1.run, prompt: p.prompt, log: () => {} });
    expect(p.log.enters).toHaveLength(1);

    const r2 = fakeRunner(happy({ "r2 bucket list": bad("network down") }));
    const p2 = fakePrompt();
    await expect(runInit({ name: "femtocms", runner: r2.run, prompt: p2.prompt, log: () => {} })).rejects.toThrow(/network down/);
    expect(p2.log.enters).toHaveLength(0);
  });

  it("when not logged in, runs wrangler login (interactive) and tries again", async () => {
    const r = fakeRunner(happy({
      "whoami --json": [bad("Not logged in"), ok(JSON.stringify({ accounts: [{ id: "acc1", name: "me" }] }))],
      login: ok(),
    }));
    await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    const login = r.calls.find((c) => c.args[0] === "login")!;
    expect(login.interactive).toBe(true);
    expect(r.calls.filter((c) => c.args[0] === "whoami")).toHaveLength(2);
  });

  it("with several accounts, asks which one to use and passes the chosen ID", async () => {
    const r = fakeRunner(happy({
      "whoami --json": ok(JSON.stringify({ accounts: [{ id: "acc1", name: "one" }, { id: "acc2", name: "two" }] })),
    }));
    const p = fakePrompt({ select: "acc2" });
    await runInit({ name: "femtocms", runner: r.run, prompt: p.prompt, log: () => {} });
    expect(p.log.selects).toHaveLength(1);
    expect(r.calls.filter((c) => c.args[0] !== "whoami").every((c) => c.env?.CLOUDFLARE_ACCOUNT_ID === "acc2")).toBe(true);
    expect(loadConfig().profiles.femtocms!.site!.accountId).toBe("acc2");
  });

  it("with account given, uses that account without asking (works without a terminal, e.g. from an AI agent)", async () => {
    const r = fakeRunner(happy({
      "whoami --json": ok(JSON.stringify({ accounts: [{ id: "acc1", name: "one" }, { id: "acc2", name: "two" }] })),
    }));
    const p = fakePrompt();
    await runInit({ name: "femtocms", account: "acc2", runner: r.run, prompt: p.prompt, log: () => {} });
    expect(p.log.selects).toHaveLength(0);
    expect(r.calls.filter((c) => c.args[0] !== "whoami").every((c) => c.env?.CLOUDFLARE_ACCOUNT_ID === "acc2")).toBe(true);
    expect(loadConfig().profiles.femtocms!.site!.accountId).toBe("acc2");
  });

  it("when the given account is not available to this login, stops without creating anything and lists the available accounts", async () => {
    const r = fakeRunner(happy({
      "whoami --json": ok(JSON.stringify({ accounts: [{ id: "acc1", name: "one" }, { id: "acc2", name: "two" }] })),
    }));
    await expect(runInit({ name: "femtocms", account: "nope", runner: r.run, prompt: fakePrompt().prompt, log: () => {} }))
      .rejects.toThrow(/nope[\s\S]*acc1[\s\S]*acc2/);
    expect(r.calls.filter((c) => c.args[0] !== "whoami")).toHaveLength(0);
  });

  it("running init again without --domain keeps the saved domain", async () => {
    seedProfile({ url: "https://cms.example.com", site: { ...SITE, domain: "cms.example.com" } });
    const r = fakeRunner(happy({ deploy: ok("Deployed femtocms triggers\n  cms.example.com (custom domain)") }));
    const out = await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {}, fetch: fakeFetch(200).fn });
    expect(out.url).toBe("https://cms.example.com");
    expect(loadConfig().profiles.femtocms!.site!.domain).toBe("cms.example.com");
    expect(r.calls.find((c) => c.args[0] === "deploy")!.configAtCall!.routes).toEqual([{ pattern: "cms.example.com", custom_domain: true }]);
  });

  it("when r2 bucket create fails with already exists (code 10004), reuses the bucket as already created", async () => {
    for (const stderr of ["✘ [ERROR] The bucket you tried to create already exists, and you own it. [code: 10004]", "[code: 10004]"]) {
      saveConfig({ profiles: {} }); // a fresh site each time
      const r = fakeRunner(happy({ "r2 bucket create femtocms-femtocms": bad(stderr) }));
      const logs: string[] = [];
      await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: (s) => logs.push(s) });
      expect(r.has("deploy")).toBe(true);
      expect(logs.join("\n")).toContain("Reusing");
    }
  });

  it("--domain uses the custom domain URL and puts routes in the config", async () => {
    const r = fakeRunner(happy({ deploy: ok("Deployed femtocms triggers\n  femtocms.example.com (custom domain)") }));
    const out = await runInit({ name: "femtocms", domain: "cms.example.com", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expect(out.url).toBe("https://cms.example.com");
    expect(loadConfig().profiles.femtocms!.site!.domain).toBe("cms.example.com");
    const path = r.calls.find((c) => c.args[0] === "deploy")!.args[2]!;
    expect(JSON.parse(readFileSync(path, "utf8")).routes).toEqual([{ pattern: "cms.example.com", custom_domain: true }]);
  });

  it("when the deploy output has no URL, fails with an error that includes the end of the output", async () => {
    const r = fakeRunner(happy({ deploy: ok("Uploaded femtocms\nDone.") }));
    await expect(runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} })).rejects.toThrow(/URL.*Uploaded femtocms/s);
  });

  it("when deploy fails because no workers.dev subdomain is registered, registers one interactively and runs deploy again", async () => {
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

  it("when the ID cannot be read from the d1 create output, looks it up with d1 list", async () => {
    const r = fakeRunner(happy({
      "d1 list --json": [ok("[]"), ok(JSON.stringify([{ uuid: "db-from-list", name: "femtocms-femtocms" }]))],
      "d1 create femtocms-femtocms": ok("✅ Successfully created DB"),
    }));
    await runInit({ name: "femtocms", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expect(loadConfig().profiles.femtocms!.site!.d1Id).toBe("db-from-list");
  });

  it("--cors-origins is normalized, saved in site and written to vars.CORS_ORIGINS of the wrangler config", async () => {
    const r = fakeRunner(happy());
    await runInit({ name: "femtocms", corsOrigins: " https://a.example , https://b.example:8443/ ", runner: r.run, prompt: fakePrompt().prompt, log: () => {} });
    expect(loadConfig().profiles.femtocms!.site!.corsOrigins).toBe("https://a.example,https://b.example:8443");
    const deployCall = r.calls.find((c) => c.args[0] === "deploy")!;
    expect(deployCall.configAtCall!.vars).toEqual({ SITE_NAME: "femtocms", CORS_ORIGINS: "https://a.example,https://b.example:8443" });
  });

  it("running init again keeps the saved --cors-origins when it is not given, and clears it for an empty string (all origins allowed)", async () => {
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

  it("rejects a --cors-origins that is not a valid origin before calling wrangler", async () => {
    for (const bad of ["example.com", "ftp://a.example", "https://a.example/path", "https://a.example?x=1", "*"]) {
      const r = fakeRunner(happy());
      await expect(runInit({ name: "femtocms", corsOrigins: bad, runner: r.run, prompt: fakePrompt().prompt, log: () => {} }), bad)
        .rejects.toThrow("--cors-origins");
      expect(r.calls).toHaveLength(0);
    }
  });

  it("rejects an unusable profile name before calling wrangler", async () => {
    const r = fakeRunner(happy());
    await expect(runInit({ name: "Bad Name", runner: r.run, prompt: fakePrompt().prompt, log: () => {} })).rejects.toThrow(/Bad Name/);
    expect(r.calls).toHaveLength(0);
  });
});

describe("runUpgrade", () => {
  it("rebuilds the config from the saved site, runs migrations apply first, then only deploy", async () => {
    seedProfile();
    const r = fakeRunner({ deploy: ok("https://femtocms.me.workers.dev"), "d1 migrations": ok() });
    await runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} });
    expect(r.names()).toEqual(["d1 migrations", "deploy --config"]);
    expect(r.calls.every((c) => c.env?.CLOUDFLARE_ACCOUNT_ID === "acc1")).toBe(true);
    const migrate = r.calls[0]!.args;
    expect(migrate.slice(0, 5)).toEqual(["d1", "migrations", "apply", "femtocms-femtocms", "--remote"]);
    expect(existsSync(r.calls[1]!.args[2]!)).toBe(true);
  });

  it("upgrade succeeds even when the deploy output has no URL, and returns the saved URL", async () => {
    seedProfile();
    const r = fakeRunner({ deploy: ok("Uploaded femtocms\nDone."), "d1 migrations": ok() });
    expect(await runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} })).toEqual({ url: "https://femtocms.me.workers.dev" });
  });

  it("does not deploy when the migration fails", async () => {
    seedProfile();
    const r = fakeRunner({ deploy: ok("https://femtocms.me.workers.dev"), "d1 migrations": bad("boom") });
    await expect(runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} })).rejects.toThrow(/boom/);
    expect(r.has("deploy")).toBe(false);
  });

  it("saves --cors-origins and writes it to the config when given, uses the saved value when not given, and clears it for an empty string", async () => {
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

  it("refuses a profile that was not created by init", async () => {
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

  it("does nothing when the name does not match", async () => {
    seedProfile();
    const r = fakeRunner(destroyReplies);
    const f = fakeFetch();
    const done = await runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["other"] }).prompt, log: () => {}, fetch: f.fn });
    expect(done).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect(loadConfig().profiles.femtocms).toBeDefined();
  });

  it("deletes without asking when confirm is the Worker name (works without a terminal, e.g. from an AI agent), and does nothing when it differs", async () => {
    seedProfile();
    const p = fakePrompt();
    const f = fakeFetch();
    const bad = fakeRunner(destroyReplies);
    expect(await runDestroy({ profile: "femtocms", confirm: "other", runner: bad.run, prompt: p.prompt, log: () => {}, fetch: f.fn })).toBe(false);
    expect(bad.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    const r = fakeRunner(destroyReplies);
    expect(await runDestroy({ profile: "femtocms", confirm: "femtocms", runner: r.run, prompt: p.prompt, log: () => {}, fetch: f.fn })).toBe(true);
    expect(p.log.texts).toHaveLength(0);
    expect(r.calls).toHaveLength(3);
    expect(loadConfig().profiles.femtocms).toBeUndefined();
  });

  it("when it matches, empties the site through the API, deletes R2, the Worker and D1 in that order, and removes the profile and the generated config", async () => {
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

  it("when the API that empties the site returns an HTTP error (401/403/5xx/JSON error), stops without deleting anything", async () => {
    for (const status of [401, 403, 500, 503]) {
      seedProfile();
      const r = fakeRunner(destroyReplies);
      await expect(
        runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: fakeFetch(status).fn }),
      ).rejects.toThrow(new RegExp(`HTTP ${status}.*Nothing was deleted.*femtocms login`, "s"));
      expect(r.calls).toHaveLength(0);
      expect(loadConfig().profiles.femtocms).toBeDefined();
    }
  });

  it("when the host itself answers 404 (a deleted Worker) or the connection fails, continues as if the Worker is gone", async () => {
    for (const f of [fakeFetch(404, "host"), fakeFetch(200, "network")]) {
      seedProfile();
      const r = fakeRunner(destroyReplies);
      const logs: string[] = [];
      const done = await runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: (s) => logs.push(s), fetch: f.fn });
      expect(done).toBe(true);
      expect(r.calls).toHaveLength(3);
      expect(logs.join("\n")).toContain("already gone");
      expect(loadConfig().profiles).toEqual({});
    }
  });

  it("a resource that is already gone counts as success only for that resource's own wrangler answer", async () => {
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

  it("a generic not found (it may be another account) is not treated as success: it stops and keeps the profile", async () => {
    seedProfile();
    const r = fakeRunner({ ...destroyReplies, "r2 bucket delete": bad("✘ [ERROR] Not found") });
    await expect(
      runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: ["femtocms"] }).prompt, log: () => {}, fetch: fakeFetch().fn }),
    ).rejects.toThrow(/Not found/);
    expect(loadConfig().profiles.femtocms).toBeDefined();
  });

  it("when deleting R2 fails (not empty), does not delete the Worker and D1, explains how to remove the leftover objects and keeps the profile", async () => {
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

describe("revalidating the saved Worker name (a tampered config file must not delete paths outside the sites folder)", () => {
  it("upgrade and destroy reject an unusable workerName before calling wrangler or deleting any file", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    for (const workerName of ["../../outside", "Bad", ""]) {
      seedProfile({ site: { ...SITE, workerName } });
      const r = fakeRunner({ deploy: ok(), "d1 migrations": ok(), delete: ok(), "d1 delete": ok(), "r2 bucket delete": ok() });
      await expect(runUpgrade({ profile: "femtocms", runner: r.run, log: () => {} }), workerName).rejects.toThrow(/not allowed/);
      const f = fakeFetch();
      await expect(runDestroy({ profile: "femtocms", runner: r.run, prompt: fakePrompt({ texts: [workerName] }).prompt, log: () => {}, fetch: f.fn }), workerName)
        .rejects.toThrow(/not allowed/);
      expect(r.calls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(loadConfig().profiles.femtocms).toBeDefined();
    }
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});

describe("pinning the account (the user's own wrangler settings must not interfere)", () => {
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

  it("init: the config with account_id exists by the first D1/R2 call, and every call uses it through --config and cwd", async () => {
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

  it("the same holds for upgrade and destroy", async () => {
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
  it("writes plain JSON with no_bundle, SITE_NAME, the bindings and absolute paths", () => {
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

  it("leaves out d1_databases while there is no D1 ID yet", () => {
    const cfg = JSON.parse(readFileSync(writeSiteConfig({ ...SITE, d1Id: "" }, tmp), "utf8"));
    expect(cfg.d1_databases).toBeUndefined();
    expect(cfg.account_id).toBe("acc1");
  });

  it("adds vars.CORS_ORIGINS when corsOrigins is given", () => {
    const cfg = JSON.parse(readFileSync(writeSiteConfig({ ...SITE, corsOrigins: "https://a.example,https://b.example" }, tmp), "utf8"));
    expect(cfg.vars).toEqual({ SITE_NAME: "femtocms", CORS_ORIGINS: "https://a.example,https://b.example" });
  });

  it("adds the custom domain routes when domain is given", () => {
    const cfg = JSON.parse(readFileSync(writeSiteConfig({ ...SITE, domain: "cms.example.com" }, tmp), "utf8"));
    expect(cfg.routes).toEqual([{ pattern: "cms.example.com", custom_domain: true }]);
  });

  it("the compatibility date and flags match the development worker/wrangler.jsonc (a mismatch is caught here)", () => {
    const dev = JSON.parse(readFileSync(join(packageRoot(), "worker", "wrangler.jsonc"), "utf8"));
    expect(COMPATIBILITY_DATE).toBe(dev.compatibility_date);
    expect(COMPATIBILITY_FLAGS).toEqual(dev.compatibility_flags);
  });
});

describe("wrangler output parsing", () => {
  it("reads database_id from the d1 create output (in JSON, TOML or JSONC form)", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(parseDatabaseId(`{\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "x",\n      "database_id": "${id}"\n    }\n  ]\n}`)).toBe(id);
    expect(parseDatabaseId(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"\ndatabase_id = "${id}"\n`)).toBe(id);
    expect(parseDatabaseId("✅ Successfully created DB 'x'")).toBeUndefined();
  });

  it("reads the bucket name from the name: line of r2 bucket list", () => {
    expect(parseBucketNames("name:           a\ncreation_date:  2026-01-01\n\nname:           femtocms-x\ncreation_date:  2026-01-02\n")).toEqual(["a", "femtocms-x"]);
    expect(parseBucketNames("")).toEqual([]);
  });

  it("reads the workers.dev URL from the deploy output (preferring one that starts with the Worker name)", () => {
    expect(findWorkersDevUrl("Deployed w triggers\n  https://w.me.workers.dev\nCurrent Version ID: 1", "w")).toBe("https://w.me.workers.dev");
    expect(findWorkersDevUrl("see https://dash.example.workers.dev and https://w.me.workers.dev", "w")).toBe("https://w.me.workers.dev");
    expect(findWorkersDevUrl("nothing here", "w")).toBeUndefined();
  });
});

describe("defaultRunner", () => {
  it("can start the bundled wrangler with node (without touching the account)", async () => {
    const res = await defaultRunner(["--version"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/\d+\.\d+\.\d+/);
  }, 30_000);
});

describe("built worker bundle", () => {
  const built = join(packageRoot(), "dist", "worker", "index.js");
  // dist/ is a build artifact (npm run build:worker); the build script also fails loudly on its own.
  it.skipIf(!existsSync(built))("embed.client.js is embedded as a minified string and no import of an external module is left", async () => {
    const text = readFileSync(built, "utf8");
    const source = readFileSync(join(packageRoot(), "worker", "src", "public", "embed.client.js"), "utf8");
    // @ts-expect-error -- plain .mjs build helper without type declarations
    const { minifyEmbed } = await import("../../scripts/minify-embed.mjs");
    const embed = minifyEmbed(source) as string;
    expect(embed.length).toBeLessThan(source.length);
    expect(embed).not.toContain("// ---- basics");
    expect(text).toContain(JSON.stringify(embed));
    expect(text).not.toMatch(/from\s+"\.\/[^"]*\.client\.js"/);
  });
});

describe("commands", () => {
  it("registers init / upgrade / destroy", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["init", "upgrade", "destroy"]));
    const init = buildProgram().commands.find((c) => c.name() === "init")!;
    expect(init.options.map((o) => o.long)).toEqual(["--name", "--account", "--domain", "--cors-origins"]);
    const upgrade = buildProgram().commands.find((c) => c.name() === "upgrade")!;
    expect(upgrade.options.map((o) => o.long)).toEqual(["--cors-origins"]);
    const destroy = buildProgram().commands.find((c) => c.name() === "destroy")!;
    expect(destroy.options.map((o) => o.long)).toEqual(["--confirm"]);
  });
});
