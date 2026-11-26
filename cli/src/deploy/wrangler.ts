import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunOptions {
  /** Inherit the terminal (login, workers.dev registration). Nothing is captured then. */
  interactive?: boolean;
  cwd?: string;
  /** Added to the environment; this is how the chosen account reaches every call (CLOUDFLARE_ACCOUNT_ID). */
  env?: Record<string, string>;
}

export type WranglerRunner = (args: string[], opts?: RunOptions) => Promise<RunResult>;

/** The bin script of the wrangler that ships with femtocms (a dependency, so it is always the one we tested). */
function wranglerBin(): string {
  const pkgPath = createRequire(import.meta.url).resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.wrangler;
  if (!bin) throw new Error("同梱の wrangler の bin が見つかりません");
  return join(dirname(pkgPath), bin);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Runs the bundled wrangler with `node`, never through a shell: arguments reach it verbatim
 * (the bootstrap SQL has quotes, `$` and backticks). Captured runs get no stdin, so a prompt can never hang them.
 */
export const defaultRunner: WranglerRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    if (!opts.interactive) {
      env.NO_COLOR = "1";
      delete env.FORCE_COLOR; // node warns when both are set
    }
    let child;
    try {
      child = spawn(process.execPath, [wranglerBin(), ...args], {
        cwd: opts.cwd,
        env,
        stdio: opts.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: 1, stdout: "", stderr: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.replace(ANSI_RE, ""), stderr: stderr.replace(ANSI_RE, "") }));
  });

// --- output parsing ----------------------------------------------------------------------------

/** wrangler may print a banner around JSON: parse the whole text, else the outermost {...} / [...]. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

/** `d1 create` prints a config snippet: `"database_id": "<uuid>"` (JSON/JSONC) or `database_id = "<uuid>"` (TOML). */
export function parseDatabaseId(text: string): string | undefined {
  return /["']?database_id["']?\s*[:=]\s*["']([^"'\s]+)["']/.exec(text)?.[1];
}

/** `r2 bucket list` has no --json: it prints `name:   <bucket>` blocks. */
export function parseBucketNames(text: string): string[] {
  return [...text.matchAll(/^\s*name:\s+(\S+)/gm)].map((m) => m[1]!);
}

/** `https://<worker>.<subdomain>.workers.dev` from deploy output; a URL that starts with the worker's name wins. */
export function findWorkersDevUrl(text: string, workerName: string): string | undefined {
  const urls = [...text.matchAll(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/gi)].map((m) => m[0]);
  return urls.find((u) => u.toLowerCase().startsWith(`https://${workerName.toLowerCase()}.`)) ?? urls[0];
}

/** R2 is opt-in per account: the API answers with code 10042 / "Please enable R2 through the Cloudflare Dashboard". */
export function isR2NotEnabled(r: RunResult): boolean {
  return r.code !== 0 && /\b10042\b|enable R2/i.test(`${r.stdout}\n${r.stderr}`);
}

/** The last lines of a failed run, for error messages. */
export function outputTail(r: RunResult, lines = 15): string {
  return `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-lines).join("\n");
}
