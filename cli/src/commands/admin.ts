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
    throw new Error("Confirmation required: pass --confirm <site> (the site name is the --name you gave to femtocms init; GET / returns it as \"site\")");
  }
  const answer = await (opts.prompter ?? clackPrompter)(`${what}\nType the site name to confirm`);
  if (!answer) throw new Error("Cancelled");
  return answer;
}

// --- keys ---------------------------------------------------------------------------------------

export async function keysCreate(client: FemtoClient, opts: { name: string; role?: string }): Promise<unknown> {
  const role = opts.role ?? "read";
  if (role !== "admin" && role !== "read") throw new Error(`--role must be admin or read (got: "${role}")`);
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

export async function resetCmd(client: FemtoClient, opts: ConfirmOpts): Promise<unknown> {
  const confirm = await resolveConfirm(opts, "This moves all content (entries, media, collections) to the trash. API keys are kept.");
  return client.request("POST", "/api/reset", { json: { confirm } });
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
    const fail = (why: string) => new Error(`Could not download media ${m.id}: ${why}`);
    if (!m.url) throw fail("it has no url");
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

/** `GET /` reports the site name as `site` (the Worker's SITE_NAME, i.e. the init --name). */
async function assertSiteName(client: FemtoClient, confirm: string): Promise<void> {
  const root = await client.request<{ site?: unknown }>("GET", "/");
  if (root?.site !== confirm) {
    throw new Error(
      `The --confirm value "${confirm}" does not match the site name ("${String(root?.site)}"; it is the --name you gave femtocms init, and GET / returns it as site). Nothing was written`,
    );
  }
}

export async function importCmd(client: FemtoClient, dir: string, opts: ImportOpts): Promise<unknown> {
  const dataPath = join(dir, "data.json");
  let text: string;
  try {
    text = readFileSync(dataPath, "utf8");
  } catch (e) {
    throw new Error(`Could not read ${dataPath}: ${(e as Error).message}`);
  }
  let data: ExportFile;
  try {
    data = JSON.parse(text) as ExportFile;
  } catch {
    throw new Error(`Could not parse ${dataPath} as JSON`);
  }
  // Ask first: a refusal must happen before any request (media PUTs included).
  const confirm = opts.replace ? await resolveConfirm(opts, "This moves all existing data to the trash and replaces it.") : undefined;
  // The server checks confirm only in POST /api/import, after the media PUTs: check it against GET / first so a typo writes nothing.
  if (confirm !== undefined) await assertSiteName(client, confirm);

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
    .description("Save a site connection using an admin key (the key is checked with GET /api/keys before it is saved)")
    .requiredOption("--url <url>", "URL of the site")
    .requiredOption("--key <key>", "Admin key (fcms_admin_...)")
    .option("--name <profile>", "Profile name (default: the host name of the URL)")
    .action(
      guarded(async (o: { url: string; key: string; name?: string }, cmd: Command) => {
        let parsed: URL;
        try {
          parsed = new URL(o.url);
        } catch {
          throw new Error(`Not a valid URL: ${o.url}`);
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("The URL must start with http:// or https://");
        }
        const name = o.name ?? profileNameFromUrl(parsed);
        if (!PROFILE_NAME_RE.test(name)) {
          throw new Error(`The profile name "${name}" is not allowed. Use lowercase letters, digits and hyphens, starting with a letter or digit`);
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
            human: () => `Logged in: ${name} (${url}) key: ${keyPrefix}...`,
          },
        );
      }),
    );

  program
    .command("logout")
    .description("Remove a saved profile")
    .option("--name <profile>", "Profile to remove (default: the current profile)")
    .action(
      guarded(async (o: { name?: string }, cmd: Command) => {
        const config = loadConfig();
        const name = o.name ?? config.current;
        if (!name) throw new Error("There is no profile to remove. Pass --name");
        if (!Object.hasOwn(config.profiles, name)) {
          throw new Error(`The profile "${name}" is not saved`);
        }
        delete config.profiles[name];
        if (config.current === name) delete config.current;
        saveConfig(config);
        print(
          { removed: name },
          { json: Boolean(cmd.optsWithGlobals().json), human: () => `Logged out: ${name}` },
        );
      }),
    );

  const keys = program.command("keys").description("Manage API keys");
  keys
    .command("create")
    .description("Create an API key (the key is shown only once, when it is created)")
    .requiredOption("--name <name>", "Name of the key")
    .option("--role <role>", "admin | read (default: read)")
    .action(
      guarded(async (o: { name: string; role?: string }, cmd: Command) => {
        print(await keysCreate(clientFor(cmd), o), {
          json: isJson(cmd),
          human: (r) => {
            const { key, info } = r as { key: string; info: { id: string; role: string } };
            return `${key}\nid: ${info.id}  role: ${info.role}\nThis key will not be shown again. Save it now`;
          },
        });
      }),
    );
  keys
    .command("list")
    .description("List API keys")
    .action(
      guarded(async (_o: object, cmd: Command) => {
        print(await keysList(clientFor(cmd)), {
          json: isJson(cmd),
          human: (r) => {
            const rows = ((r as { items: Record<string, string | null>[] }).items).map((k) => [
              k.id!, k.name!, k.role!, k.prefix!, k.revokedAt ? "revoked" : "active",
            ]);
            return rows.length === 0 ? "(none)" : table([["id", "name", "role", "prefix", "state"], ...rows]);
          },
        });
      }),
    );
  keys
    .command("revoke <id>")
    .description("Revoke an API key (the last active admin key cannot be revoked)")
    .action(
      guarded(async (id: string, o: object, cmd: Command) => {
        print(await keysRevoke(clientFor(cmd), id, o), { json: isJson(cmd), human: () => `Revoked: ${id}` });
      }),
    );

  program
    .command("reset")
    .description("Move all content (entries, media, collections) to the trash; nothing is deleted for good (requires the site name)")
    .option("--confirm <site>", "Site name (if omitted, an interactive terminal asks for it)")
    .action(
      guarded(async (o: ConfirmOpts, cmd: Command) => {
        print(await resetCmd(clientFor(cmd), o), {
          json: isJson(cmd),
          human: (r) =>
            `Moved to the trash (${(r as { trashed: number }).trashed} items). To delete for good, run femtocms trash empty --confirm <site>`,
        });
      }),
    );

  program
    .command("export")
    .description("Write data.json and media/ to a folder")
    .option("--out <dir>", "Output folder (default: ./femtocms-export-YYYYMMDD-HHmmss)")
    .action(
      guarded(async (o: { out?: string }, cmd: Command) => {
        print(await exportCmd(clientFor(cmd), o), {
          json: isJson(cmd),
          human: (r) => {
            const x = r as { dir: string; collections: number; entries: number; media: number };
            return `Exported to ${x.dir} (collections ${x.collections}, entries ${x.entries}, media ${x.media})`;
          },
        });
      }),
    );

  program
    .command("import <dir>")
    .description(
      "Import from a folder written by export. Files in media/ are sent with PUT /api/media/<id> before the data is validated, even when merging" +
        " (if validation fails, only the files stay behind; running the import again overwrites them under the same ids)",
    )
    .option("--replace", "Move existing data to the trash and replace it (requires the site name)")
    .option("--confirm <site>", "Site name for --replace (if omitted, an interactive terminal asks for it)")
    .action(
      guarded(async (dir: string, o: ImportOpts, cmd: Command) => {
        print(await importCmd(clientFor(cmd), dir, o), {
          json: isJson(cmd),
          human: (r) => {
            const x = r as { collections: number; entries: number; media: number };
            return `Imported (collections ${x.collections}, entries ${x.entries}, media ${x.media})`;
          },
        });
      }),
    );
}
