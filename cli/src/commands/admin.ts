import type { Command } from "commander";
import { FemtoClient } from "../client";
import { PROFILE_NAME_RE, loadConfig, saveConfig } from "../config";
import { print, printError } from "../output";

const KEY_SHOWN = 16;

/** Default profile name: the URL's hostname reduced to [a-z0-9-]. */
function profileNameFromUrl(url: URL): string {
  const name = url.hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name.slice(0, 64) || "default";
}

/** Run a command body, routing any failure through printError (never prints keys). */
function guarded<A extends unknown[]>(
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
}
