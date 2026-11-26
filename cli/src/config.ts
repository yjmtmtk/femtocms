import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface Profile {
  url: string;
  key: string;
  site?: {
    workerName: string;
    d1Name: string;
    d1Id: string;
    bucket: string;
    accountId: string;
    domain?: string;
    /** Comma-separated CORS allow-list written as the Worker's CORS_ORIGINS; absent means every origin. */
    corsOrigins?: string;
  };
}

export interface ConfigFile {
  current?: string;
  profiles: Record<string, Profile>;
}

/** Profile names become object keys and appear in file names, so keep them boring. */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : join(homedir(), ".config");
  return join(base, "femtocms", "config.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadConfig(): ConfigFile {
  const path = configPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw new Error(`設定ファイル ${path} を読めませんでした: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never echo file contents: they hold API keys.
    throw new Error(`設定ファイル ${path} が壊れています（JSON として読めません）。修正するか削除して femtocms login をやり直してください`);
  }
  if (!isRecord(parsed) || (parsed.profiles !== undefined && !isRecord(parsed.profiles))) {
    throw new Error(`設定ファイル ${path} の形式が正しくありません`);
  }
  const config: ConfigFile = { profiles: (parsed.profiles ?? {}) as Record<string, Profile> };
  if (typeof parsed.current === "string") config.current = parsed.current;
  return config;
}

export function saveConfig(c: ConfigFile): void {
  const path = configPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600); // writeFileSync's mode is subject to umask
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function lookup(config: ConfigFile, name: string): Profile {
  const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
  if (!profile) {
    throw new Error(`プロファイル "${name}" は登録されていません。femtocms login --name ${name} で登録してください`);
  }
  return profile;
}

function findProjectFile(cwd: string): string | undefined {
  let dir = resolve(cwd);
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, "femtocms.json");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

export function resolveProfile(opts: {
  profile?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): { name: string; profile: Profile } {
  const { FEMTOCMS_URL: envUrl, FEMTOCMS_KEY: envKey } = opts.env;
  if (envUrl && envKey) return { name: "env", profile: { url: envUrl, key: envKey } };

  if (opts.profile) return { name: opts.profile, profile: lookup(loadConfig(), opts.profile) };

  const projectFile = findProjectFile(opts.cwd);
  if (projectFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(projectFile, "utf8"));
    } catch {
      throw new Error(`${projectFile} を JSON として読めませんでした`);
    }
    if (isRecord(parsed)) {
      if (typeof parsed.profile === "string") {
        return { name: parsed.profile, profile: lookup(loadConfig(), parsed.profile) };
      }
      if (typeof parsed.url === "string" && typeof parsed.key === "string") {
        return { name: "femtocms.json", profile: { url: parsed.url, key: parsed.key } };
      }
    }
    throw new Error(`${projectFile} には "profile" か "url" と "key" を書いてください`);
  }

  const config = loadConfig();
  if (config.current) return { name: config.current, profile: lookup(config, config.current) };

  throw new Error("接続先が設定されていません。femtocms init か femtocms login を実行してください");
}
