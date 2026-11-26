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

const CANCELLED = "キャンセルしました";

async function clack() {
  if (!process.stdin.isTTY) throw new Error("この操作は対話端末（ターミナル）で実行してください");
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

const failure = (what: string, r: RunResult) => new Error(`${what}に失敗しました（wrangler の終了コード ${r.code}）\n${outputTail(r)}`);

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
    throw new Error(`名前 "${name}" は使えません（小文字英数字とハイフン、先頭は英数字、64 文字まで）`);
  }
}

function checkDomain(domain: string): void {
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    throw new Error(`--domain にはホスト名だけを指定してください（例: cms.example.com）。受け取った値: "${domain}"`);
  }
}

interface Account { id: string; name?: string }

async function pickAccount(runner: WranglerRunner, prompt: Prompter, log: (s: string) => void): Promise<string> {
  let who = await runner(["whoami", "--json"]);
  if (who.code !== 0) {
    log("Cloudflare にログインします。ブラウザが開くので、許可してください。");
    const login = await runner(["login"], { interactive: true });
    if (login.code !== 0) throw new Error("Cloudflare へのログインに失敗しました");
    who = await runner(["whoami", "--json"]);
    if (who.code !== 0) throw failure("ログイン状態の確認", who);
  }
  const accounts = ((extractJson(who.stdout) as { accounts?: Account[] } | undefined)?.accounts ?? []).filter((a) => a?.id);
  if (accounts.length === 0) throw new Error("この Cloudflare ログインに使えるアカウントがありません");
  if (accounts.length === 1) return accounts[0]!.id;
  return prompt.select("使う Cloudflare アカウントを選んでください", accounts.map((a) => ({ value: a.id, label: a.name ? `${a.name} (${a.id})` : a.id })));
}

async function listDatabases(run: WranglerRunner): Promise<{ uuid: string; name: string }[]> {
  const r = await run(["d1", "list", "--json"]);
  if (r.code !== 0) throw failure("D1 一覧の取得", r);
  const parsed = extractJson(r.stdout);
  return Array.isArray(parsed) ? (parsed as { uuid: string; name: string }[]) : [];
}

async function ensureDatabase(run: WranglerRunner, d1Name: string, log: (s: string) => void): Promise<string> {
  const existing = (await listDatabases(run)).find((d) => d.name === d1Name);
  if (existing) {
    log(`D1 データベース ${d1Name} は作成済みです。再利用します`);
    return existing.uuid;
  }
  log(`D1 データベース ${d1Name} を作成します`);
  const created = await run(["d1", "create", d1Name]);
  if (created.code !== 0) throw failure("D1 の作成", created);
  // The snippet wrangler prints varies by version and config format: fall back to asking for the list.
  const id = parseDatabaseId(`${created.stdout}\n${created.stderr}`) ?? (await listDatabases(run)).find((d) => d.name === d1Name)?.uuid;
  if (!id) throw new Error(`D1 ${d1Name} の ID を取得できませんでした。wrangler d1 list で確認してください\n${outputTail(created)}`);
  return id;
}

async function ensureBucket(run: WranglerRunner, bucket: string, accountId: string, prompt: Prompter, log: (s: string) => void): Promise<void> {
  for (;;) {
    let step = await run(["r2", "bucket", "list"]);
    if (step.code === 0) {
      if (parseBucketNames(step.stdout).includes(bucket)) {
        log(`R2 バケット ${bucket} は作成済みです。再利用します`);
        return;
      }
      log(`R2 バケット ${bucket} を作成します`);
      step = await run(["r2", "bucket", "create", bucket]);
      if (step.code === 0) return;
    }
    if (!isR2NotEnabled(step)) throw failure("R2 の確認・作成", step);
    log(
      "R2 がまだ有効になっていません。次の URL を開いて R2 を有効にしてください（無料枠の範囲で使えます。支払い方法の登録を求められることがあります）:\n" +
        `  https://dash.cloudflare.com/${accountId}/r2/overview`,
    );
    await prompt.waitEnter("有効にしたら Enter を押してください（やめるときは Ctrl-C）");
  }
}

/** Deploys and returns the site URL. A brand-new account has no workers.dev subdomain: wrangler must ask the user, so that one step runs interactively. */
async function deploy(run: WranglerRunner, site: Site, log: (s: string) => void): Promise<string> {
  const args = ["deploy"];
  let r = await run(args);
  if (r.code !== 0 && /workers\.dev subdomain/i.test(`${r.stdout}\n${r.stderr}`)) {
    log("このアカウントにはまだ workers.dev のサブドメインがありません。画面の案内に従って登録してください。");
    const registered = await run(args, { interactive: true });
    if (registered.code !== 0) throw new Error("workers.dev のサブドメイン登録とデプロイに失敗しました");
    r = await run(args);
  }
  if (r.code !== 0) throw failure("デプロイ", r);
  if (site.domain) return `https://${site.domain}`;
  const url = findWorkersDevUrl(`${r.stdout}\n${r.stderr}`, site.workerName);
  if (!url) throw new Error(`デプロイの出力から URL を取得できませんでした。出力の末尾:\n${outputTail(r)}`);
  return url;
}

async function migrate(run: WranglerRunner, d1Name: string): Promise<void> {
  const r = await run(["d1", "migrations", "apply", d1Name, "--remote"]);
  if (r.code !== 0) throw failure("マイグレーションの適用", r);
}

/** True only when the saved key still works as an admin key on the deployed site. */
async function savedKeyWorks(profile: Profile | undefined, url: string, fetchImpl: typeof fetch | undefined): Promise<boolean> {
  if (!profile?.key) return false;
  try {
    await new FemtoClient({ url, key: profile.key }, fetchImpl).request("GET", "/api/keys");
    return true;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return false;
    throw new Error(`保存済みのキーを ${url} で確認できませんでした（${(e as Error).message}）。少し待ってからもう一度 femtocms init を実行してください`);
  }
}

export function summaryLines(out: { url: string; key: string; mcpUrl: string }, keyIsNew: boolean): string[] {
  return [
    "",
    "femtocms の準備ができました。",
    "",
    `API の URL: ${out.url}`,
    `管理キー:   ${out.key}`,
    keyIsNew
      ? "  このキーが表示されるのはこの1回だけです。パスワード管理ツールなど安全な場所に保存してください（サーバにはハッシュだけが保存されます）。"
      : "  保存済みのキーが使えたので、そのまま再利用しました。",
    `MCP の URL: ${out.mcpUrl}`,
    "",
    "Claude Code に MCP サーバを追加するには:",
    `  claude mcp add --transport http femtocms ${out.mcpUrl} --header "Authorization: Bearer ${out.key}"`,
    "",
    "LP に埋め込むコード:",
    '  <div data-femtocms="news" data-limit="5"></div>',
    `  <script src="${out.url}/embed.js" defer></script>`,
    "",
  ];
}

// --- init --------------------------------------------------------------------------------------

export interface InitOpts {
  name: string;
  domain?: string;
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

  const accountId = await pickAccount(opts.runner, prompt, log);
  const d1Name = `femtocms-${name}`;
  const bucket = `femtocms-${name}`;

  // The config exists before the first D1/R2 call (it pins the account); the database id is filled in once known.
  const draft: Site = { workerName: name, d1Name, d1Id: "", bucket, accountId, ...(opts.domain ? { domain: opts.domain } : {}) };
  const configPath = writeSiteConfig(draft);
  const run = bindSite(opts.runner, accountId, configPath);

  const d1Id = await ensureDatabase(run, d1Name, log);
  await ensureBucket(run, bucket, accountId, prompt, log);

  const site: Site = { ...draft, d1Id };
  writeSiteConfig(site);
  log("Worker をデプロイします（少し時間がかかります）");
  const url = await deploy(run, site, log);
  log("データベースのマイグレーションを適用します");
  await migrate(run, d1Name);

  let key: string;
  let keyIsNew = false;
  const existing = Object.hasOwn(loadConfig().profiles, name) ? loadConfig().profiles[name] : undefined;
  if (await savedKeyWorks(existing, url, opts.fetch)) {
    key = existing!.key;
  } else {
    log("管理キーを作成します");
    key = generateKey("admin");
    const sql = await bootstrapSql(key, "init", new Date().toISOString());
    // `--command` takes the SQL as one argument: no shell is involved, so quotes and `$` survive.
    const r = await run(["d1", "execute", d1Name, "--remote", "--yes", "--command", sql]);
    if (r.code !== 0) throw failure("管理キーの登録", r);
    keyIsNew = true;
  }

  const config = loadConfig();
  config.profiles[name] = { url, key, site };
  config.current = name;
  saveConfig(config);

  const out = { url, key, mcpUrl: `${url}/mcp` };
  if (opts.showSummary !== false) for (const line of summaryLines(out, keyIsNew)) log(line);
  return out;
}

// --- upgrade -----------------------------------------------------------------------------------

function siteOf(profile: string): { profile: Profile; site: Site } {
  const config = loadConfig();
  const p = Object.hasOwn(config.profiles, profile) ? config.profiles[profile] : undefined;
  if (!p) throw new Error(`プロファイル "${profile}" は登録されていません`);
  if (!p.site) throw new Error(`プロファイル "${profile}" は femtocms init で作られたものではないため、Cloudflare 側の情報がありません。femtocms init で作り直してください`);
  return { profile: p, site: p.site };
}

export async function runUpgrade(opts: { profile: string; runner: WranglerRunner; log: (s: string) => void }): Promise<{ url: string }> {
  const { profile, site } = siteOf(opts.profile);
  const run = bindSite(opts.runner, site.accountId, writeSiteConfig(site));
  opts.log("Worker を更新します（少し時間がかかります）");
  await deploy(run, site, opts.log);
  opts.log("データベースのマイグレーションを適用します");
  await migrate(run, site.d1Name);
  opts.log(`更新しました: ${profile.url}`);
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
      log(`サイトに接続できませんでした（${(e as Error).message}）。Worker が既に無いものとして続けます`);
      return;
    }
    if (e.status === 404 && e.code.startsWith("http_")) {
      log("サイトの URL が 404 を返しました。Worker が既に無いものとして続けます");
      return;
    }
    throw new Error(
      `サイトを空にできませんでした（HTTP ${e.status}: ${e.message}）。R2 にデータが残ったまま削除すると後から消せなくなるため、何も削除していません。` +
        "femtocms login で有効な管理キーを保存し直してから、もう一度 destroy を実行してください",
    );
  }
}

export async function runDestroy(opts: {
  profile: string; runner: WranglerRunner; prompt: Prompter; log: (s: string) => void; fetch?: typeof fetch;
}): Promise<boolean> {
  const { log } = opts;
  const { profile, site } = siteOf(opts.profile);
  const typed = (await opts.prompt.text(
    `Cloudflare 上の Worker・D1・R2（記事・メディアを含むすべて）を削除します。元には戻せません。\n続けるには Worker 名 "${site.workerName}" を入力してください`,
  )).trim();
  if (typed !== site.workerName) {
    log("入力が一致しないため、何もせずに中止しました");
    return false;
  }

  // R2 buckets must be empty to be deleted: reset moves everything to the trash, emptying the trash deletes the media objects.
  log("データを空にします");
  await emptySite(new FemtoClient(profile, opts.fetch), site.workerName, log);

  const run = bindSite(opts.runner, site.accountId, writeSiteConfig(site));
  // R2 first: it is the step that can fail on leftover data, and while the Worker still exists a retry can empty it again.
  const steps: [string, keyof typeof ALREADY_GONE, string[]][] = [
    ["R2 バケット", "r2", ["r2", "bucket", "delete", site.bucket]],
    ["Worker", "worker", ["delete", "--name", site.workerName, "--force"]],
    ["D1 データベース", "d1", ["d1", "delete", site.d1Name, "-y"]],
  ];
  for (const [label, kind, args] of steps) {
    log(`${label}を削除します`);
    const r = await run(args);
    if (r.code === 0) continue;
    if (ALREADY_GONE[kind].test(`${r.stdout}\n${r.stderr}`)) {
      log(`  ${label}は既にありませんでした`);
      continue;
    }
    throw failure(`${label}の削除`, r);
  }

  const config = loadConfig();
  delete config.profiles[opts.profile];
  if (config.current === opts.profile) delete config.current;
  saveConfig(config);
  rmSync(dirname(siteConfigPath(site.workerName)), { recursive: true, force: true }); // the generated config
  log(`削除しました: ${site.workerName}`);
  return true;
}

// --- commands ----------------------------------------------------------------------------------

/** The prebuilt worker must exist before anything is created in the user's account. */
function assertBundled(): void {
  const { main, migrationsDir } = bundledPaths();
  if (!existsSync(main)) throw new Error(`同梱の Worker (${main}) が見つかりません。リポジトリから実行している場合は npm run build:worker を先に実行してください`);
  if (!existsSync(migrationsDir)) throw new Error(`マイグレーション (${migrationsDir}) が見つかりません`);
}

const stderrLog = (s: string) => void process.stderr.write(s + "\n");
const stdoutLog = (s: string) => void process.stdout.write(s + "\n");

function profileNameOf(cmd: Command): string {
  const { name, profile } = resolveProfile({ profile: cmd.optsWithGlobals().profile as string | undefined, cwd: process.cwd(), env: process.env });
  if (!profile.site) throw new Error("このプロファイルは femtocms init で作られたものではありません。femtocms init で作り直してください");
  return name;
}

export function registerDeploy(program: Command): void {
  program
    .command("init")
    .description("自分の Cloudflare アカウントに femtocms をデプロイして接続情報を保存します（何度実行しても安全です）")
    .option("--name <name>", "Worker・D1・R2 とプロファイルの名前", "femtocms")
    .option("--domain <host>", "独自ドメイン（例: cms.example.com。そのドメインが Cloudflare の管理下にあること）")
    .action(
      guarded(async (o: { name: string; domain?: string }, cmd: Command) => {
        assertBundled();
        const json = isJson(cmd);
        // --json: progress goes to stderr and the result (including the key) only to stdout.
        const out = await runInit({
          name: o.name, domain: o.domain, runner: defaultRunner, prompt: clackPrompter,
          log: json ? stderrLog : stdoutLog, showSummary: !json,
        });
        if (json) print(out, { json: true });
      }),
    );

  program
    .command("upgrade")
    .description("同梱の最新の Worker をデプロイし、マイグレーションを適用します")
    .action(
      guarded(async (_o: object, cmd: Command) => {
        assertBundled();
        const json = isJson(cmd);
        const out = await runUpgrade({ profile: profileNameOf(cmd), runner: defaultRunner, log: json ? stderrLog : stdoutLog });
        if (json) print(out, { json: true });
      }),
    );

  program
    .command("destroy")
    .description("Cloudflare 上の Worker・D1・R2 をすべて削除します（Worker 名の入力が必要）")
    .action(
      guarded(async (_o: object, cmd: Command) => {
        const json = isJson(cmd);
        const destroyed = await runDestroy({ profile: profileNameOf(cmd), runner: defaultRunner, prompt: clackPrompter, log: json ? stderrLog : stdoutLog });
        if (json) print({ destroyed }, { json: true });
      }),
    );
}
