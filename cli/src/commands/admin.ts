import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { FemtoClient } from "../client";
import { PROFILE_NAME_RE, loadConfig, resolveProfile, saveConfig } from "../config";
import { print, printError, table } from "../output";

const KEY_SHOWN = 16;

/** Default profile name: the URL's hostname reduced to [a-z0-9-]. */
function profileNameFromUrl(url: URL): string {
  const name = url.hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name.slice(0, 64) || "default";
}

/** Run a command body, routing any failure through printError (never prints keys). */
export function guarded<A extends unknown[]>(
  fn: (...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      const cmd = args[args.length - 1] as Command;
      printError(e, { json: Boolean(cmd.optsWithGlobals().json) });
    }
  };
}

export const isJson = (cmd: Command): boolean => Boolean(cmd.optsWithGlobals().json);

/** The API client for the profile that --profile, the environment, femtocms.json or the current profile selects. */
export function clientFor(cmd: Command): FemtoClient {
  const { profile } = resolveProfile({
    profile: cmd.optsWithGlobals().profile as string | undefined,
    cwd: process.cwd(),
    env: process.env,
  });
  return new FemtoClient(profile);
}

// --- confirmation -------------------------------------------------------------------------------

export type Prompter = (message: string) => Promise<string | undefined>;

/** `isTTY` and `prompter` exist so tests never touch a real terminal. */
export interface ConfirmOpts { confirm?: string; isTTY?: boolean; prompter?: Prompter }

async function clackPrompter(message: string): Promise<string | undefined> {
  const clack = await import("@clack/prompts");
  const answer = await clack.text({ message });
  return clack.isCancel(answer) ? undefined : answer;
}

/** The site name for a destructive call: --confirm, else a prompt on a terminal, else an error (before any request). */
export async function resolveConfirm(opts: ConfirmOpts, what: string): Promise<string> {
  if (opts.confirm) return opts.confirm;
  const tty = opts.isTTY ?? process.stdin.isTTY === true;
  if (!tty) {
    throw new Error("サイト名の確認が必要です: pass --confirm <site>（サイト名は Worker の SITE_NAME です）");
  }
  const answer = await (opts.prompter ?? clackPrompter)(`${what}\nサイト名を入力してください`);
  if (!answer) throw new Error("キャンセルしました");
  return answer;
}

// --- keys ---------------------------------------------------------------------------------------

export async function keysCreate(client: FemtoClient, opts: { name: string; role?: string }): Promise<unknown> {
  const role = opts.role ?? "read";
  if (role !== "admin" && role !== "read") throw new Error(`--role は admin か read です（受け取った値: "${role}"）`);
  return client.request("POST", "/api/keys", { json: { name: opts.name, role } });
}

export async function keysList(client: FemtoClient): Promise<unknown> {
  return client.request("GET", "/api/keys");
}

export async function keysRevoke(client: FemtoClient, id: string, _opts: object): Promise<unknown> {
  return client.request("DELETE", `/api/keys/${encodeURIComponent(id)}`);
}

// --- export / import ----------------------------------------------------------------------------

interface ExportedMedia { id: string; filename?: string; mimeType?: string; alt?: string; url?: string }
interface ExportFile { collections?: unknown[]; entries?: unknown[]; media?: ExportedMedia[] }

const MEDIA_ID_RE = /^m_[0-9a-z]{12}$/;

/** A file name that is safe to join onto a directory: basename only, no separators or control characters. */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned.slice(0, 200);
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface ExportOpts { out?: string; fetch?: typeof fetch }

export async function exportCmd(client: FemtoClient, opts: ExportOpts): Promise<unknown> {
  const dir = opts.out ?? `./femtocms-export-${timestamp()}`;
  const data = await client.request<ExportFile>("GET", "/api/export");
  const download = opts.fetch ?? globalThis.fetch;
  const mediaDir = join(dir, "media");
  mkdirSync(mediaDir, { recursive: true });

  // Media first, data.json last: a half-finished export never looks complete. Media is public, so no auth header.
  for (const m of data.media ?? []) {
    const fail = (why: string) => new Error(`メディア ${m.id} をダウンロードできませんでした: ${why}`);
    if (!m.url) throw fail("url がありません");
    let res: Response;
    try {
      res = await download(m.url);
    } catch (e) {
      throw fail((e as Error).message);
    }
    if (!res.ok) throw fail(`HTTP ${res.status} (${m.url})`);
    writeFileSync(join(mediaDir, `${safeFilename(m.id)}-${safeFilename(m.filename ?? "file")}`), new Uint8Array(await res.arrayBuffer()));
  }
  writeFileSync(join(dir, "data.json"), JSON.stringify(data, null, 2) + "\n");
  return {
    dir, collections: data.collections?.length ?? 0, entries: data.entries?.length ?? 0, media: data.media?.length ?? 0,
  };
}

export interface ImportOpts extends ConfirmOpts { replace?: boolean }

export async function importCmd(client: FemtoClient, dir: string, opts: ImportOpts): Promise<unknown> {
  const dataPath = join(dir, "data.json");
  let text: string;
  try {
    text = readFileSync(dataPath, "utf8");
  } catch (e) {
    throw new Error(`${dataPath} を読めませんでした: ${(e as Error).message}`);
  }
  let data: ExportFile;
  try {
    data = JSON.parse(text) as ExportFile;
  } catch {
    throw new Error(`${dataPath} を JSON として読めませんでした`);
  }
  // Ask first: a refusal must happen before any request (media PUTs included).
  const confirm = opts.replace ? await resolveConfirm(opts, "既存のデータをすべてゴミ箱へ移して置き換えます。") : undefined;

  let localFiles: string[];
  try {
    localFiles = readdirSync(join(dir, "media")).sort();
  } catch {
    localFiles = [];
  }
  for (const m of data.media ?? []) {
    const local = MEDIA_ID_RE.test(m.id) ? localFiles.find((f) => f.startsWith(`${m.id}-`)) : undefined;
    if (!local) continue; // no local file: a media with a url is fetched by the server
    await client.request("PUT", `/api/media/${m.id}`, {
      query: { filename: m.filename ?? local.slice(m.id.length + 1), alt: m.alt || undefined },
      body: new Uint8Array(readFileSync(join(dir, "media", local))),
      headers: m.mimeType ? { "Content-Type": m.mimeType } : undefined,
    });
    delete m.url;
  }
  return client.request("POST", "/api/import", { json: { data, mode: opts.replace ? "replace" : "merge", confirm } });
}

export function registerAdmin(program: Command): void {
  program
    .command("login")
    .description("管理キーで接続先を登録します（GET /api/keys で管理キーかどうかを確認してから保存）")
    .requiredOption("--url <url>", "サイトの URL")
    .requiredOption("--key <key>", "管理キー（fcms_admin_...）")
    .option("--name <profile>", "プロファイル名（省略時は URL のホスト名）")
    .action(
      guarded(async (o: { url: string; key: string; name?: string }, cmd: Command) => {
        let parsed: URL;
        try {
          parsed = new URL(o.url);
        } catch {
          throw new Error(`URL として読めません: ${o.url}`);
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("URL は http:// か https:// で始めてください");
        }
        const name = o.name ?? profileNameFromUrl(parsed);
        if (!PROFILE_NAME_RE.test(name)) {
          throw new Error(`プロファイル名 "${name}" は使えません（小文字英数字とハイフン、先頭は英数字）`);
        }
        const url = o.url.replace(/\/+$/, "");

        await new FemtoClient({ url, key: o.key }).request("GET", "/api/keys");

        const config = loadConfig();
        config.profiles[name] = { url, key: o.key };
        config.current = name;
        saveConfig(config);

        const keyPrefix = o.key.slice(0, KEY_SHOWN);
        print(
          { profile: name, url, keyPrefix },
          {
            json: Boolean(cmd.optsWithGlobals().json),
            human: () => `ログインしました: ${name} (${url}) キー: ${keyPrefix}...`,
          },
        );
      }),
    );

  program
    .command("logout")
    .description("保存済みのプロファイルを削除します")
    .option("--name <profile>", "削除するプロファイル名（省略時は現在のプロファイル）")
    .action(
      guarded(async (o: { name?: string }, cmd: Command) => {
        const config = loadConfig();
        const name = o.name ?? config.current;
        if (!name) throw new Error("削除するプロファイルがありません。--name で指定してください");
        if (!Object.hasOwn(config.profiles, name)) {
          throw new Error(`プロファイル "${name}" は登録されていません`);
        }
        delete config.profiles[name];
        if (config.current === name) delete config.current;
        saveConfig(config);
        print(
          { removed: name },
          { json: Boolean(cmd.optsWithGlobals().json), human: () => `ログアウトしました: ${name}` },
        );
      }),
    );

  const keys = program.command("keys").description("API キーを管理します");
  keys
    .command("create")
    .description("API キーを作成（キーは作成時にだけ表示されます）")
    .requiredOption("--name <name>", "キーの名前")
    .option("--role <role>", "admin | read（既定は read）")
    .action(
      guarded(async (o: { name: string; role?: string }, cmd: Command) => {
        print(await keysCreate(clientFor(cmd), o), {
          json: isJson(cmd),
          human: (r) => {
            const { key, info } = r as { key: string; info: { id: string; role: string } };
            return `${key}\nid: ${info.id}  role: ${info.role}\nこのキーはもう表示されません。今のうちに保存してください`;
          },
        });
      }),
    );
  keys
    .command("list")
    .description("API キー一覧")
    .action(
      guarded(async (_o: object, cmd: Command) => {
        print(await keysList(clientFor(cmd)), {
          json: isJson(cmd),
          human: (r) => {
            const rows = ((r as { items: Record<string, string | null>[] }).items).map((k) => [
              k.id!, k.name!, k.role!, k.prefix!, k.revokedAt ? "revoked" : "active",
            ]);
            return rows.length === 0 ? "（なし）" : table([["id", "name", "role", "prefix", "state"], ...rows]);
          },
        });
      }),
    );
  keys
    .command("revoke <id>")
    .description("API キーを無効にする（最後の有効な管理キーは無効にできません）")
    .action(
      guarded(async (id: string, o: object, cmd: Command) => {
        print(await keysRevoke(clientFor(cmd), id, o), { json: isJson(cmd), human: () => `無効にしました: ${id}` });
      }),
    );

  program
    .command("export")
    .description("data.json と media/ をフォルダに書き出す")
    .option("--out <dir>", "出力先（既定: ./femtocms-export-YYYYMMDD-HHmmss）")
    .action(
      guarded(async (o: { out?: string }, cmd: Command) => {
        print(await exportCmd(clientFor(cmd), o), {
          json: isJson(cmd),
          human: (r) => {
            const x = r as { dir: string; collections: number; entries: number; media: number };
            return `${x.dir} に書き出しました（コレクション ${x.collections}、エントリ ${x.entries}、メディア ${x.media}）`;
          },
        });
      }),
    );

  program
    .command("import <dir>")
    .description("export のフォルダから取り込む（media/ のファイルを先に送ります）")
    .option("--replace", "既存のデータをゴミ箱へ移して置き換える（サイト名の確認が必要）")
    .option("--confirm <site>", "--replace のためのサイト名（省略時、対話端末なら入力を促します）")
    .action(
      guarded(async (dir: string, o: ImportOpts, cmd: Command) => {
        print(await importCmd(clientFor(cmd), dir, o), {
          json: isJson(cmd),
          human: (r) => {
            const x = r as { collections: number; entries: number; media: number };
            return `取り込みました（コレクション ${x.collections}、エントリ ${x.entries}、メディア ${x.media}）`;
          },
        });
      }),
    );
}
