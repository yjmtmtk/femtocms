import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { ApiError, FemtoClient } from "../client";
import { PROFILE_NAME_RE, loadConfig, resolveProfile, saveConfig, type Profile } from "../config";
import { bundledPaths, siteConfigPath, writeSiteConfig } from "../deploy/site-config";
import {
  defaultRunner, extractJson, findWorkersDevUrl, isR2NotEnabled, outputTail, parseBucketNames, parseDatabaseId,
  type RunResult, type WranglerRunner,
} from "../deploy/wrangler";
import { print } from "../output";
import { generateKey, bootstrapSql } from "../../../worker/src/core/key-format";
import { guarded, isJson } from "./admin";

type Site = NonNullable<Profile["site"]>;

/** Interactive questions. Production uses @clack/prompts; tests pass a fake. A cancel (Ctrl-C) throws. */
export type Prompter = {
  confirm(msg: string): Promise<boolean>;
  text(msg: string): Promise<string>;
  select<T>(msg: string, options: { value: T; label: string }[]): Promise<T>;
  waitEnter(msg: string): Promise<void>;
};

const CANCELLED = "Cancelled";

async function clack() {
  if (!process.stdin.isTTY) throw new Error("This operation needs an interactive terminal. Run it in a terminal");
  return import("@clack/prompts");
}

export const clackPrompter: Prompter = {
  async confirm(msg) {
    const c = await clack();
    const v = await c.confirm({ message: msg });
    if (c.isCancel(v)) throw new Error(CANCELLED);
    return v;
  },
  async text(msg) {
    const c = await clack();
    const v = await c.text({ message: msg });
    if (c.isCancel(v)) throw new Error(CANCELLED);
    return v ?? "";
  },
  async select<T>(msg: string, options: { value: T; label: string }[]) {
    const c = await clack();
    const v = await c.select({ message: msg, options: options as { value: string; label: string }[] });
    if (c.isCancel(v)) throw new Error(CANCELLED);
    return v as T;
  },
  async waitEnter(msg) {
    const c = await clack();
    const v = await c.text({ message: msg });
    if (c.isCancel(v)) throw new Error(CANCELLED);
  },
};

// --- helpers -----------------------------------------------------------------------------------

const failure = (what: string, r: RunResult) => new Error(`Failed to ${what} (wrangler exit code ${r.code})\n${outputTail(r)}`);

/**
 * Every account-touching call is pinned to the chosen account three ways: the account in the environment, our generated
 * config (which carries account_id) via --config, and that config's directory as cwd. Wrangler otherwise walks up from the
 * cwd to the user's own config, whose account_id would win over the environment.
 */
function bindSite(runner: WranglerRunner, accountId: string, configPath: string): WranglerRunner {
  return (args, opts) =>
    runner([...args, "--config", configPath], {
      ...opts,
      cwd: dirname(configPath),
      env: { ...opts?.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    });
}

function checkName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(`The name "${name}" is not allowed. Use lowercase letters, digits and hyphens, starting with a letter or digit, up to 64 characters`);
  }
}

function checkDomain(domain: string): void {
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    throw new Error(`--domain takes a host name only, for example cms.example.com. Got: "${domain}"`);
  }
}

/**
 * `--cors-origins a,b` -> "https://a,https://b" (each one an http(s) origin, trailing slash dropped). "" -> "" (allow every origin).
 * The Worker compares the request's Origin header with these strings exactly, so anything with a path, query or wildcard is refused.
 */
export function normalizeCorsOrigins(raw: string): string {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((o) => {
    let url: URL | undefined;
    try {
      url = new URL(o);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash || o.includes("*") || url.username) {
      throw new Error(`--cors-origins: "${o}" is not a valid origin. Use a form like https://www.example.com (no path, no wildcard)`);
    }
    return url.origin;
  }).join(",");
}

/** The site record with an updated CORS allow-list (undefined: keep, "": remove). */
function withCors(site: Site, corsOrigins: string | undefined): Site {
  if (corsOrigins === undefined) return site;
  const { corsOrigins: _old, ...rest } = site;
  return corsOrigins ? { ...rest, corsOrigins } : rest;
}

interface Account { id: string; name?: string }

// `wanted` (--account or CLOUDFLARE_ACCOUNT_ID) skips the question, so init also runs without a terminal (AI agents, CI).
async function pickAccount(runner: WranglerRunner, prompt: Prompter, log: (s: string) => void, wanted?: string): Promise<string> {
  let who = await runner(["whoami", "--json"]);
  if (who.code !== 0) {
    log("Logging in to Cloudflare. A browser window will open: approve the login there.");
    const login = await runner(["login"], { interactive: true });
    if (login.code !== 0) throw new Error("Cloudflare login failed");
    who = await runner(["whoami", "--json"]);
    if (who.code !== 0) throw failure("check the Cloudflare login", who);
  }
  const accounts = ((extractJson(who.stdout) as { accounts?: Account[] } | undefined)?.accounts ?? []).filter((a) => a?.id);
  if (accounts.length === 0) throw new Error("This Cloudflare login has no usable account");
  if (wanted) {
    if (accounts.some((a) => a.id === wanted)) return wanted;
    throw new Error(
      `The account "${wanted}" is not available to this Cloudflare login. Available accounts:\n` +
      accounts.map((a) => `  ${a.id}${a.name ? `  ${a.name}` : ""}`).join("\n"),
    );
  }
  if (accounts.length === 1) return accounts[0]!.id;
  return prompt.select("Choose the Cloudflare account to use", accounts.map((a) => ({ value: a.id, label: a.name ? `${a.name} (${a.id})` : a.id })));
}

async function listDatabases(run: WranglerRunner): Promise<{ uuid: string; name: string }[]> {
  const r = await run(["d1", "list", "--json"]);
  if (r.code !== 0) throw failure("list D1 databases", r);
  const parsed = extractJson(r.stdout);
  return Array.isArray(parsed) ? (parsed as { uuid: string; name: string }[]) : [];
}

async function ensureDatabase(run: WranglerRunner, d1Name: string, log: (s: string) => void): Promise<string> {
  const existing = (await listDatabases(run)).find((d) => d.name === d1Name);
  if (existing) {
    log(`D1 database ${d1Name} already exists. Reusing it`);
    return existing.uuid;
  }
  log(`Creating D1 database ${d1Name}`);
  const created = await run(["d1", "create", d1Name]);
  if (created.code !== 0) throw failure("create the D1 database", created);
  // The snippet wrangler prints varies by version and config format: fall back to asking for the list.
  const id = parseDatabaseId(`${created.stdout}\n${created.stderr}`) ?? (await listDatabases(run)).find((d) => d.name === d1Name)?.uuid;
  if (!id) throw new Error(`Could not get the ID of D1 database ${d1Name}. Check with wrangler d1 list\n${outputTail(created)}`);
  return id;
}

const BUCKET_EXISTS = /\[code: 10004\]|already exists/i;

async function ensureBucket(run: WranglerRunner, bucket: string, accountId: string, prompt: Prompter, log: (s: string) => void): Promise<void> {
  for (;;) {
    let step = await run(["r2", "bucket", "list"]);
    if (step.code === 0) {
      if (parseBucketNames(step.stdout).includes(bucket)) {
        log(`R2 bucket ${bucket} already exists. Reusing it`);
        return;
      }
      log(`Creating R2 bucket ${bucket}`);
      step = await run(["r2", "bucket", "create", bucket]);
      if (step.code === 0) return;
      // The list is not paginated, so a bucket beyond its first page shows up here instead.
      if (BUCKET_EXISTS.test(`${step.stdout}\n${step.stderr}`)) {
        log(`R2 bucket ${bucket} already exists. Reusing it`);
        return;
      }
    }
    if (!isR2NotEnabled(step)) throw failure("check or create the R2 bucket", step);
    log(
      "R2 is not enabled on this account yet. Open the URL below to enable it (it works within the free tier, but Cloudflare may ask you to add a payment method):\n" +
        `  https://dash.cloudflare.com/${accountId}/r2/overview`,
    );
    await prompt.waitEnter("Press Enter once R2 is enabled (Ctrl-C to quit)");
  }
}

/**
 * Deploys and returns the site URL (undefined when it cannot be read from wrangler's output: only init needs it) with the
 * tail of that output. A brand-new account has no workers.dev subdomain: wrangler must ask the user, so that one step runs interactively.
 */
async function deploy(run: WranglerRunner, site: Site, log: (s: string) => void): Promise<{ url?: string; tail: string }> {
  const args = ["deploy"];
  let r = await run(args);
  if (r.code !== 0 && /workers\.dev subdomain/i.test(`${r.stdout}\n${r.stderr}`)) {
    log("This account has no workers.dev subdomain yet. Follow the prompts to register one.");
    const registered = await run(args, { interactive: true });
    if (registered.code !== 0) throw new Error("Registering the workers.dev subdomain and deploying failed");
    r = await run(args);
  }
  if (r.code !== 0) throw failure("deploy", r);
  const url = site.domain ? `https://${site.domain}` : findWorkersDevUrl(`${r.stdout}\n${r.stderr}`, site.workerName);
  return { url, tail: outputTail(r) };
}

async function migrate(run: WranglerRunner, d1Name: string): Promise<void> {
  const r = await run(["d1", "migrations", "apply", d1Name, "--remote"]);
  if (r.code !== 0) throw failure("apply migrations", r);
}

/** True only when the saved key still works as an admin key on the deployed site. */
async function savedKeyWorks(profile: Profile | undefined, url: string, fetchImpl: typeof fetch | undefined): Promise<boolean> {
  if (!profile?.key) return false;
  try {
    await new FemtoClient({ url, key: profile.key }, fetchImpl).request("GET", "/api/keys");
    return true;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return false;
    throw new Error(`Could not verify the saved key at ${url} (${(e as Error).message}). Wait a moment, then run femtocms init again`);
  }
}

export function summaryLines(out: { url: string; key: string; mcpUrl: string }, keyIsNew: boolean, siteName: string): string[] {
  return [
    "",
    "femtocms is ready.",
    "",
    `Site name (used for --confirm in trash empty, reset and import --replace): ${siteName}`,
    `API URL:   ${out.url}`,
    `Admin key: ${out.key}`,
    keyIsNew
      ? "  This key is shown only this once. Save it somewhere safe, such as a password manager (the server stores only a hash)."
      : "  The saved key still works, so it was reused.",
    `MCP URL:   ${out.mcpUrl}`,
    "",
    "To add the MCP server to Claude Code:",
    `  claude mcp add --transport http femtocms ${out.mcpUrl} --header "Authorization: Bearer ${out.key}"`,
    "",
    "Code to embed in your landing page:",
    '  <div data-femtocms="news" data-limit="5"></div>',
    `  <script src="${out.url}/embed.js" defer></script>`,
    "",
  ];
}

// --- init --------------------------------------------------------------------------------------

export interface InitOpts {
  name: string;
  /** Cloudflare account id; without it a login with several accounts is asked which one to use. */
  account?: string;
  domain?: string;
  /** Comma-separated allowed origins; "" allows every origin; undefined keeps what the profile has. */
  corsOrigins?: string;
  runner: WranglerRunner;
  prompt: Prompter;
  log: (s: string) => void;
  /** Print the URL, key and snippets through `log` (default true; --json turns it off). */
  showSummary?: boolean;
  fetch?: typeof fetch;
}

export async function runInit(opts: InitOpts): Promise<{ url: string; key: string; mcpUrl: string }> {
  const { name, log, prompt } = opts;
  checkName(name);
  if (opts.domain) checkDomain(opts.domain);
  const cors = opts.corsOrigins === undefined ? undefined : normalizeCorsOrigins(opts.corsOrigins);
  const saved = Object.hasOwn(loadConfig().profiles, name) ? loadConfig().profiles[name]?.site : undefined;

  const accountId = await pickAccount(opts.runner, prompt, log, opts.account);
  const d1Name = `femtocms-${name}`;
  const bucket = `femtocms-${name}`;

  // The config exists before the first D1/R2 call (it pins the account); the database id is filled in once known.
  const domain = opts.domain ?? saved?.domain; // a re-run without --domain keeps the custom domain
  const draft: Site = withCors({
    workerName: name, d1Name, d1Id: "", bucket, accountId,
    ...(domain ? { domain } : {}),
    ...(saved?.corsOrigins ? { corsOrigins: saved.corsOrigins } : {}),
  }, cors);
  const configPath = writeSiteConfig(draft);
  const run = bindSite(opts.runner, accountId, configPath);

  const d1Id = await ensureDatabase(run, d1Name, log);
  await ensureBucket(run, bucket, accountId, prompt, log);

  const site: Site = { ...draft, d1Id };
  writeSiteConfig(site);
  log("Deploying the Worker (this takes a moment)");
  const deployed = await deploy(run, site, log);
  if (!deployed.url) throw new Error(`Could not find the URL in the deploy output. End of the output:\n${deployed.tail}`);
  const url = deployed.url;
  log("Applying database migrations");
  await migrate(run, d1Name);

  let key: string;
  let keyIsNew = false;
  const existing = Object.hasOwn(loadConfig().profiles, name) ? loadConfig().profiles[name] : undefined;
  if (await savedKeyWorks(existing, url, opts.fetch)) {
    key = existing!.key;
  } else {
    log("Creating the admin key");
    key = generateKey("admin");
    const sql = await bootstrapSql(key, "init", new Date().toISOString());
    // `--command` takes the SQL as one argument: no shell is involved, so quotes and `$` survive.
    const r = await run(["d1", "execute", d1Name, "--remote", "--yes", "--command", sql]);
    if (r.code !== 0) throw failure("register the admin key", r);
    keyIsNew = true;
  }

  const config = loadConfig();
  config.profiles[name] = { url, key, site };
  config.current = name;
  saveConfig(config);

  const out = { url, key, mcpUrl: `${url}/mcp` };
  if (opts.showSummary !== false) for (const line of summaryLines(out, keyIsNew, name)) log(line);
  return out;
}

// --- upgrade -----------------------------------------------------------------------------------

function siteOf(profile: string): { profile: Profile; site: Site } {
  const config = loadConfig();
  const p = Object.hasOwn(config.profiles, profile) ? config.profiles[profile] : undefined;
  if (!p) throw new Error(`The profile "${profile}" is not saved`);
  if (!p.site) throw new Error(`The profile "${profile}" was not created by femtocms init, so it has no Cloudflare details. Run femtocms init to recreate it`);
  // workerName names a directory under sites/ that destroy removes: never trust what the config file says.
  checkName(String(p.site.workerName));
  return { profile: p, site: p.site };
}

export async function runUpgrade(opts: {
  profile: string; runner: WranglerRunner; log: (s: string) => void;
  /** Comma-separated allowed origins; "" allows every origin; undefined keeps the stored value. */
  corsOrigins?: string;
}): Promise<{ url: string }> {
  const { profile, site: stored } = siteOf(opts.profile);
  const site = withCors(stored, opts.corsOrigins === undefined ? undefined : normalizeCorsOrigins(opts.corsOrigins));
  if (site !== stored) {
    const config = loadConfig();
    config.profiles[opts.profile] = { ...profile, site };
    saveConfig(config);
  }
  const run = bindSite(opts.runner, site.accountId, writeSiteConfig(site));
  // Migrations first: a new Worker may need the new schema, while the old one keeps working on an added table or column.
  opts.log("Applying database migrations");
  await migrate(run, site.d1Name);
  opts.log("Updating the Worker (this takes a moment)");
  await deploy(run, site, opts.log); // the URL is already saved; wrangler's output is not needed
  opts.log(`Updated: ${profile.url}`);
  return { url: profile.url };
}

// --- destroy -----------------------------------------------------------------------------------

/**
 * wrangler's resource-specific "this does not exist" answers (message or API error code), per resource.
 * Deliberately narrow: a bare "not found" could just as well be the wrong account, which must never count as success.
 */
const ALREADY_GONE: Record<"worker" | "d1" | "r2", RegExp> = {
  worker: /\[code: 10007\]|This Worker does not exist/i,
  d1: /\[code: 7404\]|Couldn't find a D1 DB/i,
  r2: /\[code: 10006\]|The specified bucket does not exist/i,
};

const BUCKET_NOT_EMPTY = /\[code: 10008\]|bucket you tried to delete is not empty/i;

/** The site was emptied through the API, yet R2 still holds objects no media row points at (e.g. left by an interrupted upload). */
function bucketNotEmpty(site: Site, r: RunResult): Error {
  return new Error(
    `Could not delete the R2 bucket ${site.bucket} because it is not empty. After the site was emptied, R2 still holds files that belong to no media (for example from an interrupted upload).\n` +
      "Delete those files in one of the following ways, then run femtocms destroy again (the Worker, D1 database and profile are still in place):\n" +
      `  - One key at a time: npx wrangler r2 object delete ${site.bucket}/<key> --remote\n` +
      `  - In the dashboard: https://dash.cloudflare.com/${site.accountId}/r2/default/buckets/${site.bucket}\n` +
      outputTail(r),
  );
}

/**
 * Empties the site through its API so the R2 bucket can be deleted. Returns normally when done or when the site is
 * clearly absent: the connection fails (no such host, refused, timeout) or the host itself answers 404 with a non-femtocms
 * body (a deleted Worker's workers.dev URL). Any other HTTP answer (401/403 for a revoked key, 5xx, a JSON error from the
 * site) means the Worker may be alive with data in R2, so it throws and nothing has been deleted yet.
 */
async function emptySite(client: FemtoClient, siteName: string, log: (s: string) => void): Promise<void> {
  try {
    await client.request("POST", "/api/reset", { json: { confirm: siteName } });
    await client.request("DELETE", "/api/trash", { query: { confirm: siteName } });
  } catch (e) {
    if (!(e instanceof ApiError)) {
      log(`Could not connect to the site (${(e as Error).message}). Continuing as if the Worker is already gone`);
      return;
    }
    if (e.status === 404 && e.code.startsWith("http_")) {
      log("The site URL returned 404. Continuing as if the Worker is already gone");
      return;
    }
    throw new Error(
      `Could not empty the site (HTTP ${e.status}: ${e.message}). Nothing was deleted: deleting the Worker while data remains in R2 would leave files that can no longer be removed.` +
        "Save a valid admin key with femtocms login, then run destroy again",
    );
  }
}

export async function runDestroy(opts: {
  profile: string;
  /** The Worker name, given up front (--confirm) instead of typed at the prompt, so destroy runs without a terminal. */
  confirm?: string;
  runner: WranglerRunner; prompt: Prompter; log: (s: string) => void; fetch?: typeof fetch;
}): Promise<boolean> {
  const { log } = opts;
  const { profile, site } = siteOf(opts.profile);
  const typed = (opts.confirm ?? await opts.prompt.text(
    `This deletes the Worker, D1 database and R2 bucket on Cloudflare, including all entries and media. It cannot be undone.\nTo continue, type the Worker name "${site.workerName}"`,
  )).trim();
  if (typed !== site.workerName) {
    log("The input did not match. Nothing was deleted");
    return false;
  }

  // R2 buckets must be empty to be deleted: reset moves everything to the trash, emptying the trash deletes the media objects.
  log("Emptying the site");
  await emptySite(new FemtoClient(profile, opts.fetch), site.workerName, log);

  const run = bindSite(opts.runner, site.accountId, writeSiteConfig(site));
  // R2 first: it is the step that can fail on leftover data, and while the Worker still exists a retry can empty it again.
  const steps: [string, keyof typeof ALREADY_GONE, string[]][] = [
    ["R2 bucket", "r2", ["r2", "bucket", "delete", site.bucket]],
    ["Worker", "worker", ["delete", "--name", site.workerName, "--force"]],
    ["D1 database", "d1", ["d1", "delete", site.d1Name, "-y"]],
  ];
  for (const [label, kind, args] of steps) {
    log(`Deleting ${label}`);
    const r = await run(args);
    if (r.code === 0) continue;
    if (ALREADY_GONE[kind].test(`${r.stdout}\n${r.stderr}`)) {
      log(`  ${label} was already gone`);
      continue;
    }
    if (kind === "r2" && BUCKET_NOT_EMPTY.test(`${r.stdout}\n${r.stderr}`)) throw bucketNotEmpty(site, r);
    throw failure(`delete the ${label}`, r);
  }

  const config = loadConfig();
  delete config.profiles[opts.profile];
  if (config.current === opts.profile) delete config.current;
  saveConfig(config);
  rmSync(dirname(siteConfigPath(site.workerName)), { recursive: true, force: true }); // the generated config
  log(`Deleted: ${site.workerName}`);
  return true;
}

// --- commands ----------------------------------------------------------------------------------

/** The prebuilt worker must exist before anything is created in the user's account. */
function assertBundled(): void {
  const { main, migrationsDir } = bundledPaths();
  if (!existsSync(main)) throw new Error(`The bundled Worker (${main}) was not found. If you run from the repository, run npm run build:worker first`);
  if (!existsSync(migrationsDir)) throw new Error(`The migrations (${migrationsDir}) were not found`);
}

const stderrLog = (s: string) => void process.stderr.write(s + "\n");
const stdoutLog = (s: string) => void process.stdout.write(s + "\n");

function profileNameOf(cmd: Command): string {
  const { name, profile } = resolveProfile({ profile: cmd.optsWithGlobals().profile as string | undefined, cwd: process.cwd(), env: process.env });
  if (!profile.site) throw new Error("This profile was not created by femtocms init. Run femtocms init to recreate it");
  return name;
}

const corsHelp = "Browser origins allowed to read /api and /media (comma-separated, e.g. https://www.example.com). An empty string allows every origin (default)";

export function registerDeploy(program: Command): void {
  program
    .command("init")
    .description("Deploy femtocms to your Cloudflare account and save the connection (safe to run again)")
    .option("--name <name>", "Name for the Worker, D1 database, R2 bucket and profile", "femtocms")
    .option("--account <id>", "ID of the Cloudflare account to use (default: the CLOUDFLARE_ACCOUNT_ID environment variable; if neither is set and there are several accounts, you are asked)")
    .option("--domain <host>", "Custom domain, e.g. cms.example.com (the domain must be on Cloudflare)")
    .option("--cors-origins <a,b>", corsHelp)
    .action(
      guarded(async (o: { name: string; account?: string; domain?: string; corsOrigins?: string }, cmd: Command) => {
        assertBundled();
        const json = isJson(cmd);
        // --json: progress goes to stderr and the result (including the key) only to stdout.
        const out = await runInit({
          name: o.name, account: o.account ?? (process.env.CLOUDFLARE_ACCOUNT_ID || undefined), domain: o.domain,
          corsOrigins: o.corsOrigins, runner: defaultRunner, prompt: clackPrompter,
          log: json ? stderrLog : stdoutLog, showSummary: !json,
        });
        if (json) print(out, { json: true });
      }),
    );

  program
    .command("upgrade")
    .description("Apply database migrations, then deploy the Worker bundled with this package")
    .option("--cors-origins <a,b>", `${corsHelp}. If omitted, the saved setting is kept`)
    .action(
      guarded(async (o: { corsOrigins?: string }, cmd: Command) => {
        assertBundled();
        const json = isJson(cmd);
        const out = await runUpgrade({
          profile: profileNameOf(cmd), corsOrigins: o.corsOrigins, runner: defaultRunner, log: json ? stderrLog : stdoutLog,
        });
        if (json) print(out, { json: true });
      }),
    );

  program
    .command("destroy")
    .description("Delete the Worker, D1 database and R2 bucket on Cloudflare (you must type the Worker name)")
    .option("--confirm <worker-name>", "Worker name given up front instead of typed (nothing is deleted if it does not match; for AI agents and CI)")
    .action(
      guarded(async (o: { confirm?: string }, cmd: Command) => {
        const json = isJson(cmd);
        const destroyed = await runDestroy({
          profile: profileNameOf(cmd), confirm: o.confirm, runner: defaultRunner, prompt: clackPrompter, log: json ? stderrLog : stdoutLog,
        });
        if (json) print({ destroyed }, { json: true });
      }),
    );
}
