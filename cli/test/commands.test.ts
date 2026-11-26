import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FemtoClient } from "../src/client";
import {
  collectionsCreate, collectionsDelete, collectionsUpdate, entriesCreate, entriesDelete, entriesGet, entriesList, entriesPublish,
  entriesUpdate, mediaUpdate, mediaUpload, previewCmd, trashDelete, trashEmpty, trashRestore,
} from "../src/commands/content";
import { exportCmd, importCmd, keysCreate, keysRevoke, resetCmd } from "../src/commands/admin";
import { setExit } from "../src/output";
import { buildProgram } from "../src/index";

interface Call {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  json?: any;
  body?: BodyInit | null;
}
type Handler = unknown | ((call: Call) => Response | unknown);

/** A fake server: routes are keyed "METHOD /path?query" (exact) or "METHOD /path". Every request is recorded in order. */
function recorder(routes: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body;
    const call: Call = { method, path: url.pathname, search: url.search, headers: new Headers(init?.headers), body };
    if (typeof body === "string") call.json = JSON.parse(body);
    calls.push(call);
    const key = [`${method} ${url.pathname}${url.search}`, `${method} ${url.pathname}`].find((k) => k in routes);
    if (!key) {
      return Response.json({ error: { code: "not_found", message: `no route ${method} ${url.pathname}${url.search}` } }, { status: 404 });
    }
    const h = routes[key];
    const res = typeof h === "function" ? (h as (c: Call) => unknown)(call) : h;
    if (res instanceof Response) return res;
    if (res === null) return new Response(null, { status: 204 });
    return Response.json(res);
  }) as typeof fetch;
  return { calls, fetchImpl, client: new FemtoClient({ url: "https://cms.test", key: "fcms_admin_x" }, fetchImpl) };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

const newsCollection = {
  id: "c_000000000001", name: "news", label: "お知らせ", description: null, kind: "list", public: true,
  fields: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "markdown" },
    { name: "price", type: "number" },
    { name: "featured", type: "boolean" },
    { name: "tags", type: "select", options: ["a", "b", "c"], multiple: true },
    { name: "kind", type: "select", options: ["x", "y"] },
    { name: "gallery", type: "image", multiple: true },
    { name: "related", type: "reference", collection: "news", multiple: true },
    { name: "meta", type: "json" },
  ],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const entry = { id: "e_000000000001", slug: null, status: "draft", createdAt: "", updatedAt: "", publishedAt: null, data: {}, html: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "femtocms-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe("collections", () => {
  it("create は YAML 定義を読み、フラグで上書きし、--field は name:type[:required] を解釈する", async () => {
    const r = recorder({ "POST /api/collections": entry });
    const def = file("def.yaml", "name: old\nlabel: 古い\nkind: list\nfields:\n  - name: a\n    type: text\n");
    await collectionsCreate(r.client, { file: def, name: "news", label: "お知らせ" });
    expect(r.calls[0]!.json).toEqual({ name: "news", label: "お知らせ", kind: "list", fields: [{ name: "a", type: "text" }] });

    await collectionsCreate(r.client, { name: "faq", kind: "single", field: ["q:text:required", "a:markdown"] });
    expect(r.calls[1]!.json).toEqual({
      name: "faq", kind: "single", fields: [{ name: "q", type: "text", required: true }, { name: "a", type: "markdown" }],
    });
  });

  it("create は JSON 定義も読める。--field の書式が不正ならリクエスト前にエラー", async () => {
    const r = recorder({ "POST /api/collections": entry });
    await collectionsCreate(r.client, { file: file("d.json", '{"name":"x","fields":[]}') });
    expect(r.calls[0]!.json).toEqual({ name: "x", fields: [] });
    await expect(collectionsCreate(r.client, { name: "x", field: ["bad"] })).rejects.toThrow("--field");
    await expect(collectionsCreate(r.client, { name: "x", field: ["a:text:req"] })).rejects.toThrow("required");
    await expect(collectionsCreate(r.client, { name: "x", field: ["a:nope"] })).rejects.toThrow("nope");
    expect(r.calls).toHaveLength(1);
  });

  it("update は --file を PATCH する。delete は DELETE", async () => {
    const r = recorder({ "PATCH /api/collections/news": newsCollection, "DELETE /api/collections/news": null });
    await collectionsUpdate(r.client, "news", { file: file("u.yml", "label: 新しい\n") });
    expect(r.calls[0]).toMatchObject({ method: "PATCH", path: "/api/collections/news", json: { label: "新しい" } });
    await expect(collectionsUpdate(r.client, "news", {})).rejects.toThrow("--file");
    await collectionsDelete(r.client, "news");
    expect(r.calls[1]).toMatchObject({ method: "DELETE", path: "/api/collections/news" });
  });
});

describe("entries list", () => {
  it("--filter / --fields / --expand / --sort をクエリに写す", async () => {
    const r = recorder({ "GET /api/news": { items: [], total: 0, limit: 10, offset: 0 } });
    await entriesList(r.client, "news", {
      limit: "5", offset: "10", sort: "-publishedAt", filter: ["kind=x", "price[gte]=100", "price[lte]=500"],
      fields: "title,price", expand: "related", status: "all",
    });
    const q = new URLSearchParams(r.calls[0]!.search);
    expect(Object.fromEntries(q)).toEqual({
      limit: "5", offset: "10", sort: "-publishedAt", "filter[kind]": "x", "filter[price][gte]": "100",
      "filter[price][lte]": "500", fields: "title,price", expand: "related", status: "all",
    });
  });

  it("status を指定しなければ送らない（サーバ既定は published）。不正な --filter はエラー", async () => {
    const r = recorder({ "GET /api/news": { items: [] } });
    await entriesList(r.client, "news", {});
    expect(r.calls[0]!.search).toBe("");
    await expect(entriesList(r.client, "news", { filter: ["nope"] })).rejects.toThrow("--filter");
  });
});

describe("entries create", () => {
  it("--file は front matter と本文を data に入れる", async () => {
    const post = file("post.md", "---\ntitle: 冬\n---\n# 本文");
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await entriesCreate(r.client, "news", { file: post, publish: true });
    expect(r.calls.find((c) => c.method === "POST")!.json).toEqual({ data: { title: "冬", body: "# 本文" }, status: "published" });
  });

  it("--publish が無ければ status を送らない。--slug を渡せる", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await entriesCreate(r.client, "news", { data: '{"title":"a"}', slug: "a" });
    expect(r.calls.map((c) => c.method)).toEqual(["GET", "POST"]); // the collection kind decides POST vs PUT
    expect(r.calls[1]!.json).toEqual({ data: { title: "a" }, slug: "a" });
  });

  it("--published-at は body の publishedAt になる", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await entriesCreate(r.client, "news", { data: '{"title":"a"}', publishedAt: "2026-01-02T03:04:05Z", publish: true });
    expect(r.calls[1]!.json).toEqual({ data: { title: "a" }, status: "published", publishedAt: "2026-01-02T03:04:05Z" });
  });

  it("--set は型に合わせて変換する", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await entriesCreate(r.client, "news", {
      set: [
        "price=1000", "featured=true", "tags=a, b", "kind=x", "gallery=m_000000000001,m_000000000002",
        "related=e_000000000001", 'meta={"a":[1,2]}', "title=a=b",
      ],
    });
    expect(r.calls.find((c) => c.method === "POST")!.json).toEqual({
      data: {
        price: 1000, featured: true, tags: ["a", "b"], kind: "x", gallery: ["m_000000000001", "m_000000000002"],
        related: ["e_000000000001"], meta: { a: [1, 2] }, title: "a=b",
      },
    });
  });

  it("--set の不正な値・未知のフィールドは書き込み前にエラーになる", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await expect(entriesCreate(r.client, "news", { set: ["price=abc"] })).rejects.toThrow("price");
    await expect(entriesCreate(r.client, "news", { set: ["price="] })).rejects.toThrow("price");
    await expect(entriesCreate(r.client, "news", { set: ["featured=yes"] })).rejects.toThrow("featured");
    await expect(entriesCreate(r.client, "news", { set: ["meta={bad"] })).rejects.toThrow("meta");
    await expect(entriesCreate(r.client, "news", { set: ["novalue"] })).rejects.toThrow("--set");
    const err = await entriesCreate(r.client, "news", { set: ["nope=1"] }).catch((e: Error) => e);
    expect((err as Error).message).toContain("nope");
    expect((err as Error).message).toContain("title, body, price");
    expect(writes(r.calls)).toEqual([]);
  });

  it("優先順位は --data、front matter、--set の順に上書き", async () => {
    const post = file("p.md", "---\ntitle: FM\nprice: 1\n---\nhello");
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await entriesCreate(r.client, "news", { data: '{"title":"D","kind":"y","price":0}', file: post, set: ["price=3"] });
    expect(r.calls.find((c) => c.method === "POST")!.json.data).toEqual({ title: "FM", kind: "y", price: 3, body: "hello" });
  });

  it("--data は JSON オブジェクトでなければならない", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await expect(entriesCreate(r.client, "news", { data: "[1]" })).rejects.toThrow("--data");
    await expect(entriesCreate(r.client, "news", { data: "{x" })).rejects.toThrow("--data");
    expect(r.calls).toEqual([]);
  });

  it("front matter は '---\\n' で始まるときだけ。無ければ全文が本文", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await entriesCreate(r.client, "news", { file: file("a.md", "# 見出し\n\n---\n\n続き\n") });
    expect(r.calls.find((c) => c.method === "POST")!.json.data).toEqual({ body: "# 見出し\n\n---\n\n続き" });
  });

  it("--body-field で本文の行き先を選ぶ。存在しない名前はエラー", async () => {
    const col = { ...newsCollection, fields: [{ name: "title", type: "text" }, { name: "intro", type: "markdown" }, { name: "body", type: "markdown" }] };
    const r = recorder({ "GET /api/collections/news": col, "POST /api/news": entry });
    const post = file("a.md", "---\ntitle: t\n---\ntext");
    await entriesCreate(r.client, "news", { file: post, bodyField: "body" });
    expect(r.calls.find((c) => c.method === "POST")!.json.data).toEqual({ title: "t", body: "text" });
    await entriesCreate(r.client, "news", { file: post });
    expect(r.calls.filter((c) => c.method === "POST")[1]!.json.data).toEqual({ title: "t", intro: "text" });
    await expect(entriesCreate(r.client, "news", { file: post, bodyField: "zzz" })).rejects.toThrow("zzz");
  });

  it("markdown フィールドが無くて本文があればエラー。本文が空なら front matter だけ送る", async () => {
    const col = { ...newsCollection, fields: [{ name: "title", type: "text" }] };
    const r = recorder({ "GET /api/collections/news": col, "POST /api/news": entry });
    await expect(entriesCreate(r.client, "news", { file: file("a.md", "---\ntitle: t\n---\nbody") })).rejects.toThrow("markdown");
    expect(writes(r.calls)).toEqual([]);
    await entriesCreate(r.client, "news", { file: file("b.md", "---\ntitle: t\n---\n") });
    expect(r.calls.find((c) => c.method === "POST")!.json.data).toEqual({ title: "t" });
  });

  it("front matter が mapping でない、閉じていない場合はエラー", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    await expect(entriesCreate(r.client, "news", { file: file("a.md", "---\n- a\n- b\n---\nx") })).rejects.toThrow("front matter");
    await expect(entriesCreate(r.client, "news", { file: file("b.md", "---\ntitle: t\nbody") })).rejects.toThrow("front matter");
    expect(writes(r.calls)).toEqual([]);
  });
});

describe("single collections", () => {
  const about = { ...newsCollection, name: "about", kind: "single", fields: [{ name: "title", type: "text" }, { name: "body", type: "markdown" }] };

  it("entries create は single なら PUT /api/<c> に { data, status? } を送る", async () => {
    const r = recorder({ "GET /api/collections/about": about, "PUT /api/about": entry });
    await entriesCreate(r.client, "about", { data: '{"title":"私たち"}', set: ["body=hi"], publish: true });
    const put = r.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/about");
    expect(put.json).toEqual({ data: { title: "私たち", body: "hi" }, status: "published" });
    expect(r.calls.some((c) => c.method === "POST")).toBe(false);

    await entriesCreate(r.client, "about", { data: '{"title":"x"}' });
    expect(r.calls.filter((c) => c.method === "PUT")[1]!.json).toEqual({ data: { title: "x" } });
    await expect(entriesCreate(r.client, "about", { data: "{}", slug: "s" })).rejects.toThrow("slug");
    await expect(entriesCreate(r.client, "about", { data: "{}", publishedAt: "2026-01-01T00:00:00Z" })).rejects.toThrow("--published-at");
    expect(r.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("entries get は id 省略で single の GET /api/<c>。list で id 省略はエラー", async () => {
    const r = recorder({
      "GET /api/collections/about": about, "GET /api/collections/news": newsCollection,
      "GET /api/about": { ...entry, id: "e_single" }, "GET /api/news/e1": entry,
    });
    expect(await entriesGet(r.client, ["about"])).toMatchObject({ id: "e_single" });
    expect(r.calls.at(-1)).toMatchObject({ method: "GET", path: "/api/about" });
    await expect(entriesGet(r.client, ["news"])).rejects.toThrow("id");
    expect(r.calls.at(-1)!.path).toBe("/api/collections/news"); // no entry request was made
    await entriesGet(r.client, ["news", "e1"]);
    expect(r.calls.at(-1)!.path).toBe("/api/news/e1");
  });
});

describe("entries update / publish", () => {
  it("update --publish は PATCH のあとに POST publish を呼ぶ", async () => {
    const r = recorder({
      "PATCH /api/news/e_000000000001": entry,
      "POST /api/news/e_000000000001/publish": { ...entry, status: "published" },
    });
    const result = await entriesUpdate(r.client, ["news", "e_000000000001"], { data: '{"title":"x"}', publish: true });
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /api/news/e_000000000001", "POST /api/news/e_000000000001/publish",
    ]);
    expect(r.calls[0]!.json).toEqual({ data: { title: "x" } });
    expect(result).toMatchObject({ status: "published" });
  });

  it("update --published-at だけでも PATCH { publishedAt } を送る", async () => {
    const r = recorder({ "PATCH /api/news/e1": entry });
    await entriesUpdate(r.client, ["news", "e1"], { publishedAt: "2026-01-02T00:00:00Z" });
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /api/news/e1"]);
    expect(r.calls[0]!.json).toEqual({ publishedAt: "2026-01-02T00:00:00Z" });
  });

  it("update に変更内容が無ければエラー。publish / unpublish / delete は対応する API を呼ぶ", async () => {
    const r = recorder({
      "POST /api/news/e1/publish": entry, "POST /api/news/e1/unpublish": entry, "DELETE /api/news/e1": null,
    });
    await expect(entriesUpdate(r.client, ["news", "e1"], {})).rejects.toThrow("更新");
    await entriesPublish(r.client, ["news", "e1"], {});
    await entriesDelete(r.client, ["news", "e1"], {});
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/news/e1/publish", "DELETE /api/news/e1"]);
  });
});

describe("media / preview", () => {
  it("media upload は multipart で file と alt を送る（ファイル名は basename、MIME は拡張子から）", async () => {
    const r = recorder({ "POST /api/media": { id: "m_000000000001" } });
    mkdirSync(join(dir, "sub"));
    const p = join(dir, "sub", "photo.PNG");
    writeFileSync(p, Buffer.from([137, 80, 78, 71]));
    await mediaUpload(r.client, p, { alt: "写真" });
    const form = r.calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const f = form.get("file") as File;
    expect(f.name).toBe("photo.PNG");
    expect(f.type).toBe("image/png");
    expect(f.size).toBe(4);
    expect(form.get("alt")).toBe("写真");
    expect(r.calls[0]!.headers.has("content-type")).toBe(false); // fetch adds the boundary itself
  });

  it("未知の拡張子は application/octet-stream。alt が無ければ送らない", async () => {
    const r = recorder({ "POST /api/media": { id: "m_000000000001" } });
    await mediaUpload(r.client, file("data.zzz", "x"), {});
    const form = r.calls[0]!.body as FormData;
    expect((form.get("file") as File).type).toBe("application/octet-stream");
    expect(form.has("alt")).toBe(false);
  });

  it("preview は POST して url を返す", async () => {
    const r = recorder({ "POST /api/news/e1/preview": { url: "https://cms.test/preview/t", token: "t", expiresAt: "x" } });
    expect(await previewCmd(r.client, ["news", "e1"], {})).toMatchObject({ url: "https://cms.test/preview/t" });
    expect(r.calls[0]!.json).toBeUndefined();
  });

  it("preview --ttl は ttlSeconds を送る。1..2592000 の整数でなければリクエスト前にエラー", async () => {
    const r = recorder({ "POST /api/news/e1/preview": { url: "https://cms.test/preview/t", token: "t", expiresAt: "x" } });
    await previewCmd(r.client, ["news", "e1"], { ttl: "3600" });
    expect(r.calls[0]!.json).toEqual({ ttlSeconds: 3600 });
    for (const ttl of ["0", "2592001", "1.5", "abc", ""]) {
      await expect(previewCmd(r.client, ["news", "e1"], { ttl }), ttl).rejects.toThrow("--ttl");
    }
    expect(r.calls).toHaveLength(1);
  });

  it("media upload --url は JSON { url, alt, filename } を送る。ファイルと --url はどちらか一方だけ", async () => {
    const r = recorder({ "POST /api/media": { id: "m_000000000001" } });
    await mediaUpload(r.client, undefined, { url: "https://img.test/a.png", alt: "説明", filename: "b.png" });
    expect(r.calls[0]!.json).toEqual({ url: "https://img.test/a.png", alt: "説明", filename: "b.png" });
    await mediaUpload(r.client, undefined, { url: "https://img.test/a.png" });
    expect(r.calls[1]!.json).toEqual({ url: "https://img.test/a.png" });
    await expect(mediaUpload(r.client, undefined, {})).rejects.toThrow("--url");
    await expect(mediaUpload(r.client, file("x.png", "x"), { url: "https://img.test/a.png" })).rejects.toThrow("--url");
    expect(r.calls).toHaveLength(2);
  });

  it("media upload <file> --filename は送るファイル名を変える", async () => {
    const r = recorder({ "POST /api/media": { id: "m_000000000001" } });
    await mediaUpload(r.client, file("x.png", "x"), { filename: "hero.png" });
    expect(((r.calls[0]!.body as FormData).get("file") as File).name).toBe("hero.png");
  });

  it("media update --alt は PATCH /api/media/:id { alt }。--alt が無ければエラー", async () => {
    const r = recorder({ "PATCH /api/media/m_000000000001": { id: "m_000000000001", alt: "新" } });
    expect(await mediaUpdate(r.client, "m_000000000001", { alt: "新" })).toMatchObject({ alt: "新" });
    expect(r.calls[0]!.json).toEqual({ alt: "新" });
    await mediaUpdate(r.client, "m_000000000001", { alt: "" });
    expect(r.calls[1]!.json).toEqual({ alt: "" });
    await expect(mediaUpdate(r.client, "m_000000000001", {})).rejects.toThrow("--alt");
    expect(r.calls).toHaveLength(2);
  });
});

describe("trash", () => {
  it("trash empty は --confirm を API の confirm に渡す", async () => {
    const r = recorder({ "DELETE /api/trash?confirm=dev-site": { deleted: 2 } });
    expect(await trashEmpty(r.client, { confirm: "dev-site" })).toEqual({ deleted: 2 });
    expect(r.calls[0]).toMatchObject({ method: "DELETE", path: "/api/trash", search: "?confirm=dev-site" });
  });

  it("reset は POST /api/reset に { confirm } を送る", async () => {
    const r = recorder({ "POST /api/reset": { trashed: 3 } });
    expect(await resetCmd(r.client, { confirm: "dev-site" })).toEqual({ trashed: 3 });
    expect(r.calls[0]).toMatchObject({ method: "POST", path: "/api/reset", json: { confirm: "dev-site" } });
  });

  it("reset は TTY ならプロンプトの答えを confirm にする", async () => {
    const r = recorder({ "POST /api/reset": { trashed: 0 } });
    const prompter = vi.fn(async () => "dev-site");
    await resetCmd(r.client, { isTTY: true, prompter });
    expect(prompter).toHaveBeenCalledOnce();
    expect(r.calls[0]!.json).toEqual({ confirm: "dev-site" });
  });

  it("reset は TTY でなく --confirm も無ければリクエスト前にエラー", async () => {
    const r = recorder();
    await expect(resetCmd(r.client, { isTTY: false })).rejects.toThrow("pass --confirm <site>");
    expect(r.calls).toEqual([]);
  });

  it("trash delete も confirm を渡す。restore は POST", async () => {
    const r = recorder({ "DELETE /api/trash/e_1": null, "POST /api/trash/e_1/restore": entry });
    await trashDelete(r.client, "e_1", { confirm: "dev-site" });
    await trashRestore(r.client, "e_1", {});
    expect(r.calls[0]).toMatchObject({ method: "DELETE", path: "/api/trash/e_1", search: "?confirm=dev-site" });
    expect(r.calls[1]).toMatchObject({ method: "POST", path: "/api/trash/e_1/restore" });
  });

  it("TTY でなく --confirm も無ければ、リクエスト前に 'pass --confirm <site>' でエラー", async () => {
    const r = recorder();
    const prompter = vi.fn();
    await expect(trashEmpty(r.client, { isTTY: false, prompter })).rejects.toThrow("pass --confirm <site>");
    await expect(trashDelete(r.client, "e_1", { isTTY: false, prompter })).rejects.toThrow("pass --confirm <site>");
    expect(r.calls).toEqual([]);
    expect(prompter).not.toHaveBeenCalled();
  });

  it("TTY なら prompter でサイト名を聞く。取り消されたらリクエストしない", async () => {
    const r = recorder({ "DELETE /api/trash?confirm=my-site": { deleted: 0 } });
    await trashEmpty(r.client, { isTTY: true, prompter: async () => "my-site" });
    expect(r.calls).toHaveLength(1);
    await expect(trashEmpty(r.client, { isTTY: true, prompter: async () => undefined })).rejects.toThrow("キャンセル");
    expect(r.calls).toHaveLength(1);
  });
});

describe("keys", () => {
  it("create は name と role を送る（role の既定は read）。revoke は DELETE", async () => {
    const r = recorder({ "POST /api/keys": { key: "fcms_read_x", info: {} }, "DELETE /api/keys/k_1": { id: "k_1" } });
    await keysCreate(r.client, { name: "site" });
    await keysCreate(r.client, { name: "ops", role: "admin" });
    await keysRevoke(r.client, "k_1", {});
    expect(r.calls[0]!.json).toEqual({ name: "site", role: "read" });
    expect(r.calls[1]!.json).toEqual({ name: "ops", role: "admin" });
    expect(r.calls[2]).toMatchObject({ method: "DELETE", path: "/api/keys/k_1" });
    await expect(keysCreate(r.client, { name: "x", role: "root" })).rejects.toThrow("role");
  });
});

const media = (id: string, filename: string, url?: string) => ({
  id, filename, mimeType: "image/png", size: 3, width: null, height: null, alt: "説明", createdAt: "t",
  ...(url ? { url } : {}),
});
const exportBody = (m: unknown[]) => ({
  format: "femtocms-export", version: 1, exportedAt: "t", site: "dev-site", collections: [], entries: [], media: m,
});

describe("export", () => {
  it("data.json を書き、各 media を media/<id>-<filename> に保存する（ファイル名は無害化）", async () => {
    const body = exportBody([
      media("m_000000000001", "a.png", "https://cms.test/media/m_000000000001/a.png"),
      media("m_000000000002", "../../evil/..\\x\u0000y.png", "https://cms.test/media/m_000000000002/x.png"),
    ]);
    const r = recorder({
      "GET /api/export": body,
      "GET /media/m_000000000001/a.png": () => new Response(new Uint8Array([1, 2, 3])),
      "GET /media/m_000000000002/x.png": () => new Response(new Uint8Array([4])),
    });
    const out = join(dir, "out");
    const res = await exportCmd(r.client, { out, fetch: r.fetchImpl });
    expect(res).toMatchObject({ dir: out, media: 2 });
    expect(JSON.parse(readFileSync(join(out, "data.json"), "utf8"))).toEqual(body);
    expect(readFileSync(join(out, "data.json"), "utf8")).toContain("\n  "); // pretty
    const files = readdirSync(join(out, "media")).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe("m_000000000001-a.png");
    expect(files[1]).toMatch(/^m_000000000002-[^/\\\u0000]+$/);
    expect(readdirSync(dir)).toEqual(["out"]); // nothing escaped the export dir
    expect([...readFileSync(join(out, "media", files[0]!))]).toEqual([1, 2, 3]);
    // media is public: the download carries no auth header
    const dl = r.calls.find((c) => c.path.startsWith("/media/"))!;
    expect(dl.headers.has("authorization")).toBe(false);
  });

  it("ダウンロードに失敗したら media id を示して中止し、data.json を残さない", async () => {
    const r = recorder({
      "GET /api/export": exportBody([media("m_000000000001", "a.png", "https://cms.test/media/m_000000000001/a.png")]),
      "GET /media/m_000000000001/a.png": () => new Response("nope", { status: 404 }),
    });
    const out = join(dir, "out");
    await expect(exportCmd(r.client, { out, fetch: r.fetchImpl })).rejects.toThrow("m_000000000001");
    expect(existsSync(join(out, "data.json"))).toBe(false);
  });

  it("--out の既定は ./femtocms-export-YYYYMMDD-HHmmss", async () => {
    const r = recorder({ "GET /api/export": exportBody([]) });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const res = (await exportCmd(r.client, { fetch: r.fetchImpl })) as { dir: string };
      expect(res.dir).toMatch(/^\.\/femtocms-export-\d{8}-\d{6}$/);
      expect(existsSync(join(dir, res.dir, "data.json"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("import", () => {
  function makeDir(m: unknown[], files: Record<string, string>) {
    const d = join(dir, "exp");
    mkdirSync(join(d, "media"), { recursive: true });
    writeFileSync(join(d, "data.json"), JSON.stringify(exportBody(m)));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(d, "media", name), content);
    return d;
  }
  const imported = { collections: 0, entries: 0, media: 2 };

  it("media/<id>-* を PUT してから、url を外した data.json を POST /api/import する", async () => {
    const d = makeDir(
      [
        media("m_000000000001", "a.png", "https://cms.test/media/m_000000000001/a.png"),
        media("m_000000000002", "remote.png", "https://other.test/r.png"),
      ],
      { "m_000000000001-a.png": "PNGDATA" },
    );
    const r = recorder({ "PUT /api/media/m_000000000001": media("m_000000000001", "a.png"), "POST /api/import": imported });
    await importCmd(r.client, d, {});
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /api/media/m_000000000001", "POST /api/import"]);
    const put = r.calls[0]!;
    expect(new URLSearchParams(put.search).get("filename")).toBe("a.png");
    expect(new URLSearchParams(put.search).get("alt")).toBe("説明");
    expect(put.headers.get("content-type")).toBe("image/png");
    expect(new TextDecoder().decode(put.body as Uint8Array)).toBe("PNGDATA");
    const post = r.calls[1]!.json;
    expect(post.mode).toBe("merge");
    expect(post.confirm).toBeUndefined();
    expect(post.data.media[0]).not.toHaveProperty("url");
    expect(post.data.media[1].url).toBe("https://other.test/r.png");
  });

  it("export の出力をそのまま import できる（PUT が import より先）", async () => {
    const m = media("m_000000000001", "a b.png", "https://cms.test/media/m_000000000001/a%20b.png");
    const server = recorder({
      "GET /api/export": exportBody([m]),
      "GET /media/m_000000000001/a%20b.png": () => new Response("BYTES"),
      "PUT /api/media/m_000000000001": m,
      "POST /api/import": imported,
    });
    const out = join(dir, "round");
    await exportCmd(server.client, { out, fetch: server.fetchImpl });
    server.calls.length = 0;
    await importCmd(server.client, out, {});
    expect(server.calls.map((c) => c.method)).toEqual(["PUT", "POST"]);
  });

  it("--replace は --confirm を mode と confirm に渡す", async () => {
    const d = makeDir([], {});
    const r = recorder({ "POST /api/import": imported });
    await importCmd(r.client, d, { replace: true, confirm: "dev-site" });
    expect(r.calls[0]!.json).toMatchObject({ mode: "replace", confirm: "dev-site" });
  });

  it("--replace で --confirm が無く TTY でもなければ、リクエスト前にエラー。TTY ならプロンプト", async () => {
    const d = makeDir([media("m_000000000001", "a.png")], { "m_000000000001-a.png": "x" });
    const r = recorder({ "PUT /api/media/m_000000000001": {}, "POST /api/import": imported });
    await expect(importCmd(r.client, d, { replace: true, isTTY: false })).rejects.toThrow("pass --confirm <site>");
    expect(r.calls).toEqual([]);
    await importCmd(r.client, d, { replace: true, isTTY: true, prompter: async () => "dev-site" });
    expect(r.calls.at(-1)!.json.confirm).toBe("dev-site");
  });

  it("data.json が無い・壊れているときは分かるエラー", async () => {
    const r = recorder();
    await expect(importCmd(r.client, join(dir, "missing"), {})).rejects.toThrow("data.json");
    const bad = join(dir, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "data.json"), "{x");
    await expect(importCmd(r.client, bad, {})).rejects.toThrow("data.json");
    expect(r.calls).toEqual([]);
  });
});

describe("commander wiring", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
    vi.stubEnv("FEMTOCMS_URL", "https://cms.test");
    vi.stubEnv("FEMTOCMS_KEY", "fcms_admin_x");
    setExit((code) => {
      throw new Error(`exit ${code}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setExit((code) => process.exit(code));
  });
  const run = (...args: string[]) => buildProgram().parseAsync(["node", "femtocms", ...args]);

  const page = {
    items: [
      { id: "e_000000000001", slug: "winter", status: "published", publishedAt: "2026-01-01T00:00:00.000Z", data: { price: 1, title: "冬" } },
      { id: "e_000000000002", slug: null, status: "draft", publishedAt: null, data: { n: 1 } },
    ],
    total: 2, limit: 10, offset: 0,
  };

  it("entries list --json は API の JSON をそのまま出す。人向けは id/slug/status/publishedAt/最初の文字列", async () => {
    const r = recorder({ "GET /api/news": page });
    vi.stubGlobal("fetch", r.fetchImpl);
    await run("--json", "entries", "list", "news", "--filter", "kind=x", "--status", "all");
    expect(JSON.parse(out.join(""))).toEqual(page);
    expect(r.calls[0]!.search).toContain("filter%5Bkind%5D=x");
    out.length = 0;
    await run("entries", "list", "news");
    const text = out.join("");
    expect(text).toContain("e_000000000001");
    expect(text).toContain("winter");
    expect(text).toContain("冬");
    expect(text).toContain("published");
  });

  it("entries list の --status ヘルプは既定が published だと書く", () => {
    const list = buildProgram().commands.find((c) => c.name() === "entries")!.commands.find((c) => c.name() === "list")!;
    expect(list.helpInformation()).toMatch(/published/);
    expect(list.helpInformation()).toMatch(/既定/);
  });

  it("entries create --set / --publish は repeatable で配線される", async () => {
    const r = recorder({ "GET /api/collections/news": newsCollection, "POST /api/news": entry });
    vi.stubGlobal("fetch", r.fetchImpl);
    await run("entries", "create", "news", "--set", "title=A", "--set", "price=2", "--publish");
    expect(r.calls.find((c) => c.method === "POST")!.json).toEqual({ data: { title: "A", price: 2 }, status: "published" });
  });

  it("trash empty は非 TTY で --confirm 無しならエラー終了（API を呼ばない）", async () => {
    const r = recorder();
    vi.stubGlobal("fetch", r.fetchImpl);
    await expect(run("trash", "empty")).rejects.toThrow("exit 2");
    expect(err.join("")).toContain("pass --confirm <site>");
    expect(r.calls).toEqual([]);
  });

  it("reset は非 TTY で --confirm 無しならエラー終了（API を呼ばない）", async () => {
    const r = recorder();
    vi.stubGlobal("fetch", r.fetchImpl);
    await expect(run("reset")).rejects.toThrow("exit 2");
    expect(err.join("")).toContain("pass --confirm <site>");
    expect(r.calls).toEqual([]);
  });

  it("reset --confirm は件数と trash empty の案内を表示し、--json は生の応答を出す", async () => {
    const r = recorder({ "POST /api/reset": { trashed: 4 } });
    vi.stubGlobal("fetch", r.fetchImpl);
    await run("reset", "--confirm", "dev-site");
    expect(out.join("")).toContain("4 件");
    expect(out.join("")).toContain("femtocms trash empty --confirm <site>");
    out.length = 0;
    await run("--json", "reset", "--confirm", "dev-site");
    expect(JSON.parse(out.join(""))).toEqual({ trashed: 4 });
  });

  it("keys create は作成したキーを表示する", async () => {
    const r = recorder({ "POST /api/keys": { key: "fcms_read_NEWKEY", info: { id: "k_1", name: "site", role: "read" } } });
    vi.stubGlobal("fetch", r.fetchImpl);
    await run("keys", "create", "--name", "site");
    expect(out.join("")).toContain("fcms_read_NEWKEY");
  });

  it("--published-at / preview --ttl / media upload --url / media update が配線される", async () => {
    const r = recorder({
      "GET /api/collections/news": newsCollection, "POST /api/news": entry, "PATCH /api/news/e1": entry,
      "POST /api/news/e1/preview": { url: "https://cms.test/preview/tok" }, "POST /api/media": { id: "m_1", url: "u" },
      "PATCH /api/media/m_1": { id: "m_1", alt: "a" },
    });
    vi.stubGlobal("fetch", r.fetchImpl);
    await run("entries", "create", "news", "--set", "title=A", "--published-at", "2026-01-01T00:00:00Z");
    expect(r.calls.find((c) => c.method === "POST")!.json.publishedAt).toBe("2026-01-01T00:00:00Z");
    await run("entries", "update", "news", "e1", "--published-at", "2026-01-02T00:00:00Z");
    expect(r.calls.at(-1)!.json).toEqual({ publishedAt: "2026-01-02T00:00:00Z" });
    await run("preview", "news", "e1", "--ttl", "60");
    expect(r.calls.at(-1)!.json).toEqual({ ttlSeconds: 60 });
    await run("media", "upload", "--url", "https://img.test/a.png", "--alt", "x");
    expect(r.calls.at(-1)!.json).toEqual({ url: "https://img.test/a.png", alt: "x" });
    await run("media", "update", "m_1", "--alt", "a");
    expect(r.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/api/media/m_1", json: { alt: "a" } });
  });

  it("preview は URL だけを出力する", async () => {
    const r = recorder({ "POST /api/news/e1/preview": { url: "https://cms.test/preview/tok", token: "tok", expiresAt: "x" } });
    vi.stubGlobal("fetch", r.fetchImpl);
    await run("preview", "news", "e1");
    expect(out.join("").trim()).toBe("https://cms.test/preview/tok");
  });
});
