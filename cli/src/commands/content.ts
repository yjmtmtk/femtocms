import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import type { FemtoClient } from "../client";
import { print, table } from "../output";
import type { Collection, FieldDef, FieldType } from "../../../worker/src/core/types";
import { clientFor, guarded, isJson, resolveConfirm, type ConfirmOpts } from "./admin";

type Obj = Record<string, unknown>;
/** `[collection, idOrSlug]`: commands with two positional arguments take them as a tuple. */
export type EntryRef = [collection: string, id: string];

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const collect = (v: string, prev: string[]) => [...prev, v];

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${what} ${path} を読めませんでした: ${(e as Error).message}`);
  }
}

// --- collections --------------------------------------------------------------------------------

const FIELD_TYPES: readonly FieldType[] = [
  "text", "textarea", "markdown", "number", "boolean", "datetime", "select", "image", "reference", "list", "json",
];

/** A collection definition file: `.json` is JSON, anything else is YAML (which also reads JSON). */
function readDefinition(path: string): Obj {
  const text = readText(path, "定義ファイル");
  let parsed: unknown;
  try {
    parsed = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new Error(`${path} を読めませんでした（JSON / YAML の形式が正しくありません）: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${path} はコレクション定義のオブジェクトである必要があります`);
  return parsed;
}

function parseFieldFlag(spec: string): FieldDef {
  const [name, type, flag, ...rest] = spec.split(":");
  if (!name || !type || rest.length > 0) throw new Error(`--field の書式が不正です: "${spec}"（name:type[:required]）`);
  if (!FIELD_TYPES.includes(type as FieldType)) {
    throw new Error(`--field "${spec}" の型 "${type}" は使えません。使える型: ${FIELD_TYPES.join(", ")}`);
  }
  if (flag !== undefined && flag !== "required") {
    throw new Error(`--field "${spec}" の 3 番目は required のみ指定できます`);
  }
  return flag ? { name, type: type as FieldType, required: true } : { name, type: type as FieldType };
}

export interface CollectionsCreateOpts { file?: string; name?: string; label?: string; kind?: string; field?: string[] }

export async function collectionsList(client: FemtoClient): Promise<unknown> {
  return client.request("GET", "/api/collections");
}

export async function collectionsGet(client: FemtoClient, name: string): Promise<unknown> {
  return client.request("GET", `/api/collections/${encodeURIComponent(name)}`);
}

export async function collectionsCreate(client: FemtoClient, opts: CollectionsCreateOpts): Promise<unknown> {
  const def: Obj = opts.file ? readDefinition(opts.file) : {};
  if (opts.name !== undefined) def.name = opts.name;
  if (opts.label !== undefined) def.label = opts.label;
  if (opts.kind !== undefined) def.kind = opts.kind;
  if (opts.field?.length) def.fields = opts.field.map(parseFieldFlag);
  return client.request("POST", "/api/collections", { json: def });
}

export async function collectionsUpdate(client: FemtoClient, name: string, opts: { file?: string }): Promise<unknown> {
  if (!opts.file) throw new Error("--file で更新するコレクション定義（JSON / YAML）を指定してください");
  return client.request("PATCH", `/api/collections/${encodeURIComponent(name)}`, { json: readDefinition(opts.file) });
}

export async function collectionsDelete(client: FemtoClient, name: string): Promise<unknown> {
  await client.request("DELETE", `/api/collections/${encodeURIComponent(name)}`);
  return { trashed: name };
}

// --- entries ------------------------------------------------------------------------------------

export interface EntriesListOpts {
  limit?: string | number;
  offset?: string | number;
  sort?: string;
  filter?: string[];
  fields?: string;
  expand?: string;
  status?: string;
}

export interface EntryWriteOpts {
  data?: string;
  set?: string[];
  file?: string;
  bodyField?: string;
  slug?: string;
  publish?: boolean;
  publishedAt?: string;
}

/** `k=v` -> `filter[k]=v`, `k[op]=v` -> `filter[k][op]=v`. */
function filterQuery(spec: string): [string, string] {
  const m = /^([^[\]=]+)(?:\[([^[\]=]+)\])?=(.*)$/s.exec(spec);
  if (!m) throw new Error(`--filter の書式が不正です: "${spec}"（k=v または k[op]=v）`);
  const [, key, op, value] = m;
  return [op ? `filter[${key}][${op}]` : `filter[${key}]`, value!];
}

export async function entriesList(client: FemtoClient, collection: string, opts: EntriesListOpts): Promise<unknown> {
  const query: Record<string, string | undefined> = {
    limit: opts.limit === undefined ? undefined : String(opts.limit),
    offset: opts.offset === undefined ? undefined : String(opts.offset),
    sort: opts.sort,
    fields: opts.fields,
    expand: opts.expand,
    status: opts.status,
  };
  for (const spec of opts.filter ?? []) {
    const [k, v] = filterQuery(spec);
    query[k] = v;
  }
  return client.request("GET", `/api/${encodeURIComponent(collection)}`, { query });
}

/** With no id, a single collection returns its one entry (like MCP get_entry); a list collection needs an id. */
export async function entriesGet(client: FemtoClient, [collection, id]: [collection: string, id?: string]): Promise<unknown> {
  if (id === undefined) {
    const def = await client.request<Collection>("GET", `/api/collections/${encodeURIComponent(collection)}`);
    if (def.kind !== "single") throw new Error(`コレクション "${collection}" は複数件の list です。エントリの id か slug を指定してください`);
    return client.request("GET", `/api/${encodeURIComponent(collection)}`);
  }
  return client.request("GET", entryPath(collection, id));
}

const entryPath = (collection: string, id: string, action = "") =>
  `/api/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${action}`;

/** Splits `---\n<yaml>\n---\n<body>`. Only a file that starts with `---\n` has front matter. */
function splitFrontMatter(text: string, path: string): { front: Obj; body: string } {
  if (!/^---\r?\n/.test(text)) return { front: {}, body: text };
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error(`${path} の front matter が閉じていません（2 つ目の --- がありません）`);
  let front: unknown;
  try {
    front = parseYaml(m[1] ?? "");
  } catch (e) {
    throw new Error(`${path} の front matter を YAML として読めませんでした: ${(e as Error).message}`);
  }
  if (front === null || front === undefined) front = {};
  if (!isObject(front)) throw new Error(`${path} の front matter は key: value の形（mapping）である必要があります`);
  return { front, body: text.slice(m[0].length) };
}

function coerce(field: FieldDef, raw: string): unknown {
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`--set ${field.name}=${raw}: 数値を指定してください`);
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`--set ${field.name}=${raw}: true か false を指定してください`);
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`--set ${field.name}=${raw}: JSON として読めません`);
      }
    case "select":
    case "image":
    case "reference":
      return field.multiple ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw;
    default:
      return raw;
  }
}

function parseDataFlag(text: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`--data を JSON として読めませんでした: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error("--data は JSON オブジェクト（{...}）である必要があります");
  return parsed;
}

/** Entry data from --data, then --file (front matter + body), then --set (which wins). Throws before any write. */
async function buildEntryInput(
  client: FemtoClient, collection: string, opts: EntryWriteOpts, needsSchema: boolean,
): Promise<{ data: Obj; slug?: string; kind?: Collection["kind"] }> {
  const data: Obj = opts.data === undefined ? {} : parseDataFlag(opts.data);
  const sets = opts.set ?? [];
  const def = needsSchema || sets.length > 0 || opts.file !== undefined
    ? await client.request<Collection>("GET", `/api/collections/${encodeURIComponent(collection)}`)
    : undefined;
  const fields = def?.fields ?? [];
  const names = () => fields.map((f) => f.name).join(", ");

  if (opts.file !== undefined) {
    const { front, body } = splitFrontMatter(readText(opts.file, "ファイル"), opts.file);
    Object.assign(data, front);
    const text = body.replace(/^(?:\r?\n)+/, "").trimEnd();
    if (text !== "") {
      if (opts.bodyField !== undefined && !fields.some((f) => f.name === opts.bodyField)) {
        throw new Error(`--body-field "${opts.bodyField}" はコレクション "${collection}" にありません。フィールド: ${names()}`);
      }
      const target = opts.bodyField ?? fields.find((f) => f.type === "markdown")?.name;
      if (!target) {
        throw new Error(
          `コレクション "${collection}" に markdown フィールドが無いため、本文を入れる先がありません（--body-field で指定するか、本文を空にしてください）`,
        );
      }
      data[target] = text;
    }
  }

  for (const spec of sets) {
    const i = spec.indexOf("=");
    if (i <= 0) throw new Error(`--set の書式が不正です: "${spec}"（k=v）`);
    const key = spec.slice(0, i);
    const field = fields.find((f) => f.name === key);
    if (!field) throw new Error(`--set のフィールド "${key}" はコレクション "${collection}" にありません。フィールド: ${names()}`);
    data[key] = coerce(field, spec.slice(i + 1));
  }
  return { data, slug: opts.slug, kind: def?.kind };
}

export async function entriesCreate(client: FemtoClient, collection: string, opts: EntryWriteOpts): Promise<unknown> {
  // create needs the collection's kind: a single collection is written with PUT (like MCP create_entry).
  const { data, slug, kind } = await buildEntryInput(client, collection, opts, true);
  const publishedAt = opts.publishedAt;
  if (kind === "single") {
    if (slug !== undefined) throw new Error(`コレクション "${collection}" は single のため --slug は使えません`);
    if (publishedAt !== undefined) {
      throw new Error(`コレクション "${collection}" は single のため作成時に --published-at は使えません（作成後に entries update <collection> <id> --published-at で設定してください）`);
    }
    return client.request("PUT", `/api/${encodeURIComponent(collection)}`, {
      json: { data, ...(opts.publish && { status: "published" }) },
    });
  }
  return client.request("POST", `/api/${encodeURIComponent(collection)}`, {
    json: {
      data, ...(slug !== undefined && { slug }), ...(opts.publish && { status: "published" }),
      ...(publishedAt !== undefined && { publishedAt }),
    },
  });
}

export async function entriesUpdate(client: FemtoClient, [collection, id]: EntryRef, opts: EntryWriteOpts): Promise<unknown> {
  const { data, slug } = await buildEntryInput(client, collection, opts, false);
  const publishedAt = opts.publishedAt;
  const changed = Object.keys(data).length > 0 || slug !== undefined || publishedAt !== undefined;
  if (!changed && !opts.publish) {
    throw new Error("更新する内容がありません（--data / --set / --file / --slug / --published-at / --publish のいずれかを指定してください）");
  }
  let result: unknown;
  if (changed) {
    result = await client.request("PATCH", entryPath(collection, id), {
      json: {
        ...(Object.keys(data).length > 0 && { data }), ...(slug !== undefined && { slug }),
        ...(publishedAt !== undefined && { publishedAt }),
      },
    });
  }
  return opts.publish ? client.request("POST", entryPath(collection, id, "/publish")) : result;
}

export async function entriesDelete(client: FemtoClient, [collection, id]: EntryRef, _opts: object): Promise<unknown> {
  await client.request("DELETE", entryPath(collection, id));
  return { trashed: id };
}

export async function entriesPublish(client: FemtoClient, [collection, id]: EntryRef, _opts: object): Promise<unknown> {
  return client.request("POST", entryPath(collection, id, "/publish"));
}

export async function entriesUnpublish(client: FemtoClient, [collection, id]: EntryRef, _opts: object): Promise<unknown> {
  return client.request("POST", entryPath(collection, id, "/unpublish"));
}

// --- media / preview ----------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
  wav: "audio/wav", txt: "text/plain", csv: "text/csv", json: "application/json",
};

export const mimeFromPath = (path: string): string =>
  MIME_BY_EXT[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";

export interface MediaUploadOpts { alt?: string; url?: string; filename?: string }

/** A local file (multipart) or, with --url, a remote file the server downloads (JSON { url }). Exactly one of the two. */
export async function mediaUpload(client: FemtoClient, path: string | undefined, opts: MediaUploadOpts): Promise<unknown> {
  if ((path === undefined) === (opts.url === undefined)) {
    throw new Error("アップロードするファイルのパスか --url <url> のどちらか一方を指定してください");
  }
  if (opts.url !== undefined) {
    return client.request("POST", "/api/media", {
      json: {
        url: opts.url, ...(opts.alt !== undefined && { alt: opts.alt }), ...(opts.filename !== undefined && { filename: opts.filename }),
      },
    });
  }
  const bytes = new Uint8Array(readFileSync(path!));
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mimeFromPath(path!) }), opts.filename ?? basename(path!));
  if (opts.alt !== undefined) form.set("alt", opts.alt);
  return client.request("POST", "/api/media", { body: form });
}

export async function mediaUpdate(client: FemtoClient, id: string, opts: { alt?: string }): Promise<unknown> {
  if (opts.alt === undefined) throw new Error("変更する内容がありません（--alt <text> を指定してください）");
  return client.request("PATCH", `/api/media/${encodeURIComponent(id)}`, { json: { alt: opts.alt } });
}

export async function mediaList(client: FemtoClient, opts: { limit?: string | number; offset?: string | number }): Promise<unknown> {
  return client.request("GET", "/api/media", {
    query: {
      limit: opts.limit === undefined ? undefined : String(opts.limit),
      offset: opts.offset === undefined ? undefined : String(opts.offset),
    },
  });
}

export async function mediaDelete(client: FemtoClient, id: string, _opts: object): Promise<unknown> {
  await client.request("DELETE", `/api/media/${encodeURIComponent(id)}`);
  return { trashed: id };
}

/** Same bounds as the server (core/preview.ts MAX_PREVIEW_TTL_SECONDS): 1 second to 30 days. */
const MAX_PREVIEW_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function previewCmd(client: FemtoClient, [collection, id]: EntryRef, opts: { ttl?: string }): Promise<unknown> {
  if (opts.ttl === undefined) return client.request("POST", entryPath(collection, id, "/preview"));
  const ttl = /^\d+$/.test(opts.ttl) ? Number(opts.ttl) : NaN;
  if (!(Number.isInteger(ttl) && ttl >= 1 && ttl <= MAX_PREVIEW_TTL_SECONDS)) {
    throw new Error(`--ttl は 1〜${MAX_PREVIEW_TTL_SECONDS} の整数（秒）で指定してください（受け取った値: "${opts.ttl}"）`);
  }
  return client.request("POST", entryPath(collection, id, "/preview"), { json: { ttlSeconds: ttl } });
}

// --- trash --------------------------------------------------------------------------------------

export async function trashList(client: FemtoClient): Promise<unknown> {
  return client.request("GET", "/api/trash");
}

export async function trashRestore(client: FemtoClient, id: string, _opts: object): Promise<unknown> {
  return client.request("POST", `/api/trash/${encodeURIComponent(id)}/restore`);
}

export async function trashDelete(client: FemtoClient, id: string, opts: ConfirmOpts): Promise<unknown> {
  const confirm = await resolveConfirm(opts, `${id} を完全に削除します。元に戻せません。`);
  await client.request("DELETE", `/api/trash/${encodeURIComponent(id)}`, { query: { confirm } });
  return { deleted: id };
}

export async function trashEmpty(client: FemtoClient, opts: ConfirmOpts): Promise<unknown> {
  const confirm = await resolveConfirm(opts, "ゴミ箱を空にします。元に戻せません。");
  return client.request("DELETE", "/api/trash", { query: { confirm } });
}

// --- human output -------------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

function humanList(header: string[], rows: string[][]): string {
  return rows.length === 0 ? "（なし）" : table([header, ...rows]);
}

function humanEntries(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.items)) return JSON.stringify(result, null, 2);
  const rows = (result.items as Obj[]).map((e) => {
    const data = isObject(e.data) ? e.data : {};
    const title = Object.values(data).find((v) => typeof v === "string");
    return [str(e.id), str(e.slug) || "-", str(e.status), str(e.publishedAt) || "-", str(title)];
  });
  const footer = typeof result.total === "number" ? `\n全 ${result.total} 件` : "";
  return humanList(["id", "slug", "status", "publishedAt", "title"], rows) + footer;
}

const items = (r: unknown): Obj[] => (isObject(r) && Array.isArray(r.items) ? (r.items as Obj[]) : []);

// --- commander wiring ---------------------------------------------------------------------------

export function registerContent(program: Command): void {
  const out = (cmd: Command, result: unknown, human?: (r: unknown) => string) => print(result, { json: isJson(cmd), human });

  const collections = program.command("collections").description("コレクション（スキーマ）を管理します");
  collections
    .command("list")
    .description("コレクション一覧")
    .action(guarded(async (_o: object, cmd: Command) => {
      out(cmd, await collectionsList(clientFor(cmd)), (r) =>
        humanList(["name", "kind", "fields", "label"], items(r).map((c) => [
          str(c.name), str(c.kind), String(Array.isArray(c.fields) ? c.fields.length : 0), str(c.label),
        ])));
    }));
  collections
    .command("get <name>")
    .description("コレクション定義を表示")
    .action(guarded(async (name: string, _o: object, cmd: Command) => {
      out(cmd, await collectionsGet(clientFor(cmd), name));
    }));
  collections
    .command("create")
    .description("コレクションを作成（--file の定義を、フラグで上書きできます）")
    .option("--file <path>", "定義ファイル（.json / .yaml / .yml）")
    .option("--name <name>", "コレクション名")
    .option("--label <label>", "表示名")
    .option("--kind <kind>", "list（複数件）か single（1件）")
    .option("--field <name:type[:required]>", "フィールド（繰り返し指定可。--file の fields を置き換えます）", collect, [])
    .action(guarded(async (o: CollectionsCreateOpts, cmd: Command) => {
      out(cmd, await collectionsCreate(clientFor(cmd), o), (r) => `作成しました: ${str((r as Obj).name)}`);
    }));
  collections
    .command("update <name>")
    .description("コレクション定義を更新（--file の内容を PATCH）")
    .option("--file <path>", "定義ファイル（.json / .yaml / .yml）")
    .action(guarded(async (name: string, o: { file?: string }, cmd: Command) => {
      out(cmd, await collectionsUpdate(clientFor(cmd), name, o), () => `更新しました: ${name}`);
    }));
  collections
    .command("delete <name>")
    .description("コレクションをゴミ箱へ移す")
    .action(guarded(async (name: string, _o: object, cmd: Command) => {
      out(cmd, await collectionsDelete(clientFor(cmd), name), () => `ゴミ箱へ移しました: ${name}`);
    }));

  const entries = program.command("entries").description("エントリを管理します");
  entries
    .command("list <collection>")
    .description("エントリ一覧（既定は公開済みのみ。下書きは --status draft か all）")
    .option("--limit <n>", "件数（既定 10、最大 100）")
    .option("--offset <n>", "開始位置")
    .option("--sort <keys>", "並び順（例: -publishedAt。カンマ区切り、- で降順）")
    .option("--filter <k=v>", "絞り込み（k=v または k[op]=v。繰り返し指定可）", collect, [])
    .option("--fields <a,b>", "返すフィールド")
    .option("--expand <a,b>", "展開する参照フィールド")
    .option("--status <status>", "draft | published | all（既定は published。下書きを見るには draft か all）")
    .action(guarded(async (c: string, o: EntriesListOpts, cmd: Command) => {
      out(cmd, await entriesList(clientFor(cmd), c, o), humanEntries);
    }));
  entries
    .command("get <collection> [id]")
    .description("エントリを 1 件取得（id または slug。single コレクションは id 省略可）")
    .action(guarded(async (c: string, id: string | undefined, _o: object, cmd: Command) => {
      out(cmd, await entriesGet(clientFor(cmd), [c, id]));
    }));

  const writeOptions = (cmd: Command) =>
    cmd
      .option("--data <json>", "data を JSON オブジェクトで指定")
      .option("--set <k=v>", "フィールド値（繰り返し指定可。型に合わせて変換）", collect, [])
      .option("--file <path>", "Markdown ファイル（先頭の YAML front matter を data に、本文を --body-field に入れる）")
      .option("--body-field <name>", "本文を入れるフィールド（既定: 最初の markdown フィールド）")
      .option("--slug <slug>", "slug")
      .option("--published-at <iso>", "公開日時（ISO 8601、例: 2026-11-26T09:00:00Z）")
      .option("--publish", "公開する");
  const written = (verb: string) => (r: unknown) => `${verb}しました: ${str((r as Obj).id)} (${str((r as Obj).status)})`;

  writeOptions(entries.command("create <collection>").description("エントリを作成（優先順位: --data、--file、--set）")).action(
    guarded(async (c: string, o: EntryWriteOpts, cmd: Command) => {
      out(cmd, await entriesCreate(clientFor(cmd), c, o), written("作成"));
    }),
  );
  writeOptions(entries.command("update <collection> <id>").description("エントリを更新（--publish は更新のあとに公開）")).action(
    guarded(async (c: string, id: string, o: EntryWriteOpts, cmd: Command) => {
      out(cmd, await entriesUpdate(clientFor(cmd), [c, id], o), written("更新"));
    }),
  );
  entries
    .command("delete <collection> <id>")
    .description("エントリをゴミ箱へ移す")
    .action(guarded(async (c: string, id: string, o: object, cmd: Command) => {
      out(cmd, await entriesDelete(clientFor(cmd), [c, id], o), () => `ゴミ箱へ移しました: ${id}`);
    }));
  entries
    .command("publish <collection> <id>")
    .description("エントリを公開する")
    .action(guarded(async (c: string, id: string, o: object, cmd: Command) => {
      out(cmd, await entriesPublish(clientFor(cmd), [c, id], o), written("公開"));
    }));
  entries
    .command("unpublish <collection> <id>")
    .description("エントリを下書きに戻す")
    .action(guarded(async (c: string, id: string, o: object, cmd: Command) => {
      out(cmd, await entriesUnpublish(clientFor(cmd), [c, id], o), written("下書きに戻"));
    }));

  const media = program.command("media").description("メディアを管理します");
  media
    .command("upload [file]")
    .description("ファイルをアップロード（ローカルのファイルか --url のどちらか一方）")
    .option("--url <url>", "サーバに取得させる http(s) の URL（ファイルの代わりに）")
    .option("--alt <text>", "代替テキスト")
    .option("--filename <name>", "保存するファイル名（省略時はファイル名か URL の末尾）")
    .action(guarded(async (file: string | undefined, o: MediaUploadOpts, cmd: Command) => {
      out(cmd, await mediaUpload(clientFor(cmd), file, o), (r) => `${str((r as Obj).id)}  ${str((r as Obj).url)}`);
    }));
  media
    .command("update <id>")
    .description("メディアの代替テキストを変える（ファイルと URL はそのまま）")
    .option("--alt <text>", "新しい代替テキスト（空文字で消す）")
    .action(guarded(async (id: string, o: { alt?: string }, cmd: Command) => {
      out(cmd, await mediaUpdate(clientFor(cmd), id, o), () => `更新しました: ${id}`);
    }));
  media
    .command("list")
    .description("メディア一覧")
    .option("--limit <n>", "件数（既定 10、最大 100）")
    .option("--offset <n>", "開始位置")
    .action(guarded(async (o: { limit?: string; offset?: string }, cmd: Command) => {
      out(cmd, await mediaList(clientFor(cmd), o), (r) =>
        humanList(["id", "filename", "mimeType", "size", "alt"], items(r).map((m) => [
          str(m.id), str(m.filename), str(m.mimeType), str(m.size), str(m.alt),
        ])));
    }));
  media
    .command("delete <id>")
    .description("メディアをゴミ箱へ移す")
    .action(guarded(async (id: string, o: object, cmd: Command) => {
      out(cmd, await mediaDelete(clientFor(cmd), id, o), () => `ゴミ箱へ移しました: ${id}`);
    }));

  program
    .command("preview <collection> <id>")
    .description("下書きの確認用プレビュー URL を出力")
    .option("--ttl <seconds>", "有効期間（秒、1〜2592000。既定 86400 = 24 時間）")
    .action(guarded(async (c: string, id: string, o: { ttl?: string }, cmd: Command) => {
      out(cmd, await previewCmd(clientFor(cmd), [c, id], o), (r) => str((r as Obj).url));
    }));

  const trash = program.command("trash").description("ゴミ箱を管理します");
  trash
    .command("list")
    .description("ゴミ箱の中身")
    .action(guarded(async (_o: object, cmd: Command) => {
      out(cmd, await trashList(clientFor(cmd)), (r) =>
        humanList(["type", "id", "title", "deletedAt"], items(r).map((t) => [str(t.type), str(t.id), str(t.title), str(t.deletedAt)])));
    }));
  trash
    .command("restore <id>")
    .description("ゴミ箱から戻す")
    .action(guarded(async (id: string, o: object, cmd: Command) => {
      out(cmd, await trashRestore(clientFor(cmd), id, o), () => `戻しました: ${id}`);
    }));
  trash
    .command("delete <id>")
    .description("完全に削除（サイト名の確認が必要）")
    .option("--confirm <site>", "サイト名（省略時、対話端末なら入力を促します）")
    .action(guarded(async (id: string, o: ConfirmOpts, cmd: Command) => {
      out(cmd, await trashDelete(clientFor(cmd), id, o), () => `完全に削除しました: ${id}`);
    }));
  trash
    .command("empty")
    .description("ゴミ箱を空にする（サイト名の確認が必要）")
    .option("--confirm <site>", "サイト名（省略時、対話端末なら入力を促します）")
    .action(guarded(async (o: ConfirmOpts, cmd: Command) => {
      out(cmd, await trashEmpty(clientFor(cmd), o), (r) => `ゴミ箱を空にしました（${str((r as Obj).deleted)} 件）`);
    }));
}
