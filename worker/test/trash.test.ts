import { SELF, env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { createCollection } from "../src/core/collections";
import { createCtx, getSetting } from "../src/core/context";
import { createEntry, getEntryRecord, listEntryRecords, updateEntry } from "../src/core/entries";
import { uploadMedia } from "../src/core/media";
import { mediaUrl } from "../src/core/present";
import {
  deletePermanently, emptyTrash, listTrash, restoreFromTrash, trashCollection, trashEntry, trashMedia,
} from "../src/core/trash";
import { fixtures } from "./fixtures/images";

const admin = () => createCtx(env, "https://cms.test", "admin");
const pub = () => createCtx(env, "https://cms.test", "public");
const reader = () => createCtx(env, "https://cms.test", "read");
const version = async () => Number((await getSetting(admin(), "content_version")) ?? 0);
const row = (table: string, id: string) => env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();

beforeEach(async () => {
  await createCollection(admin(), {
    name: "news", fields: [{ name: "title", type: "text" }, { name: "body", type: "markdown" }],
  });
});

describe("エントリ", () => {
  it("削除するとゴミ箱へ移り、一覧にも取得にも出ない", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" }, slug: "a", status: "published" });
    await trashEntry(admin(), "news", e.id);
    expect((await listEntryRecords(pub(), "news", {})).total).toBe(0);
    await expect(getEntryRecord(admin(), "news", e.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await listTrash(admin())).toEqual([expect.objectContaining({ type: "entry", id: e.id, title: "a", collection: "news" })]);
  });
  it("slug でも削除でき、既に削除済みなら not_found", async () => {
    await createEntry(admin(), "news", { data: { title: "a" }, slug: "a" });
    await trashEntry(admin(), "news", "a");
    await expect(trashEntry(admin(), "news", "a")).rejects.toMatchObject({ code: "not_found" });
  });
  it("title は最初の text フィールド、無ければ slug、それも無ければ id", async () => {
    await createCollection(admin(), { name: "memo", fields: [{ name: "body", type: "markdown" }, { name: "head", type: "text" }] });
    const a = await createEntry(admin(), "memo", { data: { body: "x", head: "見出し" }, slug: "s1" });
    const b = await createEntry(admin(), "memo", { data: { body: "x" }, slug: "s2" });
    const c = await createEntry(admin(), "memo", { data: {} });
    for (const e of [a, b, c]) await trashEntry(admin(), "memo", e.id);
    const titles = Object.fromEntries((await listTrash(admin())).map(t => [t.id, t.title]));
    expect(titles).toEqual({ [a.id]: "見出し", [b.id]: "s2", [c.id]: c.id });
  });
  it("復元すると公開状態に戻る", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" }, status: "published" });
    await trashEntry(admin(), "news", e.id);
    const item = await restoreFromTrash(admin(), e.id);
    expect(item).toMatchObject({ type: "entry", id: e.id, title: "a", collection: "news" });
    expect((await getEntryRecord(pub(), "news", e.id)).status).toBe("published");
    expect(await listTrash(admin())).toEqual([]);
  });
  it("ゴミ箱の slug は再利用できず、hint で理由が分かる", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" }, slug: "a" });
    await trashEntry(admin(), "news", e.id);
    await expect(createEntry(admin(), "news", { data: { title: "b" }, slug: "a" }))
      .rejects.toMatchObject({ code: "conflict", hint: expect.stringMatching(/trash|ゴミ箱/) });
  });
  it("ゴミ箱でない slug の衝突は、ゴミ箱に触れない hint（作成・更新とも）", async () => {
    await createEntry(admin(), "news", { data: { title: "a" }, slug: "a" });
    const hint = expect.not.stringMatching(/trash|ゴミ箱/);
    await expect(createEntry(admin(), "news", { data: { title: "b" }, slug: "a" }))
      .rejects.toMatchObject({ code: "conflict", hint });
    const b = await createEntry(admin(), "news", { data: { title: "b" }, slug: "b" });
    await expect(updateEntry(admin(), "news", b.id, { slug: "a" })).rejects.toMatchObject({ code: "conflict", hint });
  });
  it("更新で、ゴミ箱の slug を取ろうとしてもゴミ箱の hint", async () => {
    const gone = await createEntry(admin(), "news", { data: { title: "g" }, slug: "g" });
    await trashEntry(admin(), "news", gone.id);
    const b = await createEntry(admin(), "news", { data: { title: "b" }, slug: "b" });
    await expect(updateEntry(admin(), "news", b.id, { slug: "g" }))
      .rejects.toMatchObject({ code: "conflict", hint: expect.stringMatching(/trash|ゴミ箱/) });
  });
  it("親がゴミ箱でないエントリは普通に戻る。親がゴミ箱なら conflict で先にコレクションを戻すよう案内", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await trashEntry(admin(), "news", e.id);
    await trashCollection(admin(), "news");
    await expect(restoreFromTrash(admin(), e.id))
      .rejects.toMatchObject({ code: "conflict", hint: expect.stringContaining("先にコレクション news を復元") });
  });
  it("single コレクションで既に別のエントリがあると復元は conflict", async () => {
    await createCollection(admin(), { name: "site", kind: "single", fields: [{ name: "t", type: "text" }] });
    const first = await createEntry(admin(), "site", { data: { t: "1" } });
    await trashEntry(admin(), "site", first.id);
    await createEntry(admin(), "site", { data: { t: "2" } });
    await expect(restoreFromTrash(admin(), first.id)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("コレクション", () => {
  it("コレクション削除は配下を巻き込み、復元で一緒に戻る。先に個別削除した物は戻らない", async () => {
    const keep = await createEntry(admin(), "news", { data: { title: "k" } });
    const gone = await createEntry(admin(), "news", { data: { title: "g" } });
    await trashEntry(admin(), "news", gone.id);
    await trashCollection(admin(), "news");
    expect((await listTrash(admin())).map(t => t.type).sort()).toEqual(["collection", "entry"]);
    await expect(getEntryRecord(admin(), "news", keep.id)).rejects.toMatchObject({ code: "not_found" });
    const c = (await listTrash(admin())).find(t => t.type === "collection")!;
    expect(c).toMatchObject({ title: "news" });
    await restoreFromTrash(admin(), c.id);
    await expect(getEntryRecord(admin(), "news", keep.id)).resolves.toBeTruthy();
    await expect(getEntryRecord(admin(), "news", gone.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await row("entries", keep.id)).toMatchObject({ deleted_at: null, trashed_with: null });
  });
  it("配下だけでなく一覧には出ない（trashed_with 付きは親に含める）", async () => {
    await createEntry(admin(), "news", { data: { title: "k" } });
    await trashCollection(admin(), "news");
    expect(await listTrash(admin())).toEqual([expect.objectContaining({ type: "collection", title: "news" })]);
  });
  it("完全削除すると配下のエントリ（ゴミ箱の物も）がすべて消える", async () => {
    const a = await createEntry(admin(), "news", { data: { title: "a" } });
    const b = await createEntry(admin(), "news", { data: { title: "b" } });
    await trashEntry(admin(), "news", b.id);
    await trashCollection(admin(), "news");
    const c = (await listTrash(admin())).find(t => t.type === "collection")!;
    await deletePermanently(admin(), c.id, "dev-site");
    expect(await row("collections", c.id)).toBeNull();
    expect(await row("entries", a.id)).toBeNull();
    expect(await row("entries", b.id)).toBeNull();
  });
});

describe("メディア", () => {
  it("ゴミ箱の画像は配信されず、復元すると配信される", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    expect((await SELF.fetch(mediaUrl("https://cms.test", m))).status).toBe(200);
    await trashMedia(admin(), m.id);
    expect((await SELF.fetch(mediaUrl("https://cms.test", m))).status).toBe(404);
    expect(await listTrash(admin())).toEqual([expect.objectContaining({ type: "media", id: m.id, title: "a.png" })]);
    await restoreFromTrash(admin(), m.id);
    expect((await SELF.fetch(mediaUrl("https://cms.test", m))).status).toBe(200);
  });
  it("完全削除すると R2 からも消える。参照しているエントリはそのまま", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await trashMedia(admin(), m.id);
    await deletePermanently(admin(), m.id, "dev-site");
    expect(await env.MEDIA.get(`media/${m.id}`)).toBeNull();
    expect(await row("media", m.id)).toBeNull();
  });
});

describe("完全削除・空にする", () => {
  it("ゴミ箱に無い物は bad_request（hint つき）、存在しなければ not_found", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await expect(deletePermanently(admin(), e.id, "dev-site"))
      .rejects.toMatchObject({ code: "bad_request", hint: expect.stringContaining("ゴミ箱") });
    await expect(deletePermanently(admin(), "e_000000000000", "dev-site")).rejects.toMatchObject({ code: "not_found" });
    expect(await row("entries", e.id)).not.toBeNull();
  });
  it("完全削除には confirm が要る", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await trashEntry(admin(), "news", e.id);
    await expect(deletePermanently(admin(), e.id, undefined)).rejects.toMatchObject({ code: "confirmation_required" });
    await deletePermanently(admin(), e.id, "dev-site");
    expect(await row("entries", e.id)).toBeNull();
  });
  it("空にするには confirm にサイト名が要る。空にすると R2 からも消える", async () => {
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    await trashMedia(admin(), m.id);
    await expect(emptyTrash(admin(), "wrong")).rejects.toMatchObject({ code: "confirmation_required" });
    expect(await emptyTrash(admin(), "dev-site")).toEqual({ deleted: 1 });
    expect(await env.MEDIA.get(`media/${m.id}`)).toBeNull();
  });
  it("空にしても有効な物は残り、コレクションと配下は消える", async () => {
    const liveMedia = await uploadMedia(admin(), { bytes: fixtures.png, filename: "live.png" });
    const trashedMedia = await uploadMedia(admin(), { bytes: fixtures.gif, filename: "t.gif" });
    await trashMedia(admin(), trashedMedia.id);
    const live = await createEntry(admin(), "news", { data: { title: "live" } });
    await createCollection(admin(), { name: "old", fields: [{ name: "t", type: "text" }] });
    const child = await createEntry(admin(), "old", { data: { t: "x" } });
    await trashCollection(admin(), "old");
    const single = await createEntry(admin(), "news", { data: { title: "bye" } });
    await trashEntry(admin(), "news", single.id);

    expect(await emptyTrash(admin(), "dev-site")).toEqual({ deleted: 3 });
    expect(await listTrash(admin())).toEqual([]);
    expect(await row("entries", child.id)).toBeNull();
    expect(await row("entries", single.id)).toBeNull();
    expect(await row("entries", live.id)).not.toBeNull();
    expect(await row("media", liveMedia.id)).not.toBeNull();
    expect(await env.MEDIA.get(`media/${liveMedia.id}`)).not.toBeNull();
    expect(await env.MEDIA.get(`media/${trashedMedia.id}`)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM collections WHERE name = 'old'").first()).toBeNull();
  });
});

describe("一覧と権限", () => {
  it("新しい順に並ぶ", async () => {
    const a = await createEntry(admin(), "news", { data: { title: "a" } });
    const b = await createEntry(admin(), "news", { data: { title: "b" } });
    const ctx = admin();
    let t = Date.parse("2026-01-01T00:00:00Z");
    ctx.now = () => new Date((t += 1000));
    await trashEntry(ctx, "news", a.id);
    await trashEntry(ctx, "news", b.id);
    expect((await listTrash(admin())).map(i => i.id)).toEqual([b.id, a.id]);
  });
  it("admin 以外は使えない", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await expect(trashEntry(pub(), "news", e.id)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(trashEntry(reader(), "news", e.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(trashMedia(reader(), "m_x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(trashCollection(reader(), "news")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listTrash(reader())).rejects.toMatchObject({ code: "forbidden" });
    await expect(restoreFromTrash(reader(), e.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(deletePermanently(reader(), e.id, "dev-site")).rejects.toMatchObject({ code: "forbidden" });
    await expect(emptyTrash(pub(), "dev-site")).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("書き込み系は bumpVersion を1回ずつ呼ぶ", async () => {
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    const m = await uploadMedia(admin(), { bytes: fixtures.png, filename: "a.png" });
    const step = async (fn: () => Promise<unknown>) => {
      const v = await version();
      await fn();
      expect(await version()).toBe(v + 1);
    };
    await step(() => trashEntry(admin(), "news", e.id));
    await step(() => trashMedia(admin(), m.id));
    await step(() => restoreFromTrash(admin(), e.id));
    await step(() => trashCollection(admin(), "news"));
    await step(() => restoreFromTrash(admin(), m.id));
    await step(async () => deletePermanently(admin(), (await listTrash(admin())).find(t => t.type === "collection")!.id, "dev-site"));
    await step(() => emptyTrash(admin(), "dev-site"));
  });
  it("接頭辞が不明な id は bad_request、ゴミ箱に無い id は not_found", async () => {
    await expect(restoreFromTrash(admin(), "zzz")).rejects.toMatchObject({ code: "bad_request" });
    await expect(restoreFromTrash(admin(), "e_000000000000")).rejects.toMatchObject({ code: "not_found" });
    const e = await createEntry(admin(), "news", { data: { title: "a" } });
    await expect(restoreFromTrash(admin(), e.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
