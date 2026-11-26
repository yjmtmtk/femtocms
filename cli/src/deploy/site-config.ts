import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, type Profile } from "../config";

/**
 * Copied from worker/wrangler.jsonc rather than parsed from it at runtime: that file is a dev config
 * (and may gain comments), while these two values are part of what we deploy. A test fails if they drift apart.
 */
export const COMPATIBILITY_DATE = "2026-11-18";
export const COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** The installed femtocms package: walk up from this file to the package.json named "femtocms" (works from src/ and from a build). */
export function packageRoot(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "femtocms") return dir;
    } catch {
      // no (readable) package.json here: keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("femtocms のパッケージルートが見つかりません");
    dir = parent;
  }
}

/** The prebuilt worker (scripts/build-worker.mjs) and the D1 migrations that ship inside the package. */
export function bundledPaths(): { main: string; migrationsDir: string } {
  const root = packageRoot();
  return { main: join(root, "dist", "worker", "index.js"), migrationsDir: join(root, "worker", "migrations") };
}

/** Where generated per-site configs live: next to config.json, so XDG_CONFIG_HOME applies. */
export function sitesDir(): string {
  return join(dirname(configPath()), "sites");
}

/** `<dir>/<workerName>/wrangler.jsonc` */
export function siteConfigPath(workerName: string, dir: string = sitesDir()): string {
  return join(dir, workerName, "wrangler.jsonc");
}

/**
 * Writes `<dir>/<workerName>/wrangler.jsonc` (plain JSON, which wrangler accepts as JSONC) and returns its path.
 * `account_id` is written because a config's account_id beats CLOUDFLARE_ACCOUNT_ID: every wrangler call passes
 * this file via --config (and runs in its directory), so a wrangler config in the user's cwd can never redirect us.
 * Before the D1 database exists (`d1Id` empty) the config has no d1_databases yet; it is rewritten once the id is known.
 * `no_bundle` because dist/worker/index.js is already bundled, with embed.client.js inlined as a string.
 */
export function writeSiteConfig(site: NonNullable<Profile["site"]>, dir: string = sitesDir()): string {
  const { main, migrationsDir } = bundledPaths();
  const config: Record<string, unknown> = {
    name: site.workerName,
    account_id: site.accountId,
    main,
    no_bundle: true,
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: COMPATIBILITY_FLAGS,
    ...(site.d1Id
      ? { d1_databases: [{ binding: "DB", database_name: site.d1Name, database_id: site.d1Id, migrations_dir: migrationsDir }] }
      : {}),
    r2_buckets: [{ binding: "MEDIA", bucket_name: site.bucket }],
    vars: { SITE_NAME: site.workerName, ...(site.corsOrigins ? { CORS_ORIGINS: site.corsOrigins } : {}) },
  };
  if (site.domain) config.routes = [{ pattern: site.domain, custom_domain: true }];

  const path = siteConfigPath(site.workerName, dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}
