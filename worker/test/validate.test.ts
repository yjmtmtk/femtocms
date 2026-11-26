import { describe, expect, it } from "vitest";
import type { FieldDef } from "../src/core/types";
import { validateData } from "../src/core/validate";

const F: FieldDef[] = [
  { name: "title", type: "text", required: true, maxLength: 5 },
  { name: "n", type: "number", integer: true, min: 0 },
  { name: "tags", type: "select", options: ["a", "b"], multiple: true },
  { name: "cover", type: "image" },
  { name: "at", type: "datetime" },
  { name: "faq", type: "list", fields: [{ name: "q", type: "text", required: true }] },
  { name: "flag", type: "boolean", default: false },
];

describe("validateData", () => {
  it("正しい入力は正規化される", () => {
    const r = validateData(F, { title: "hi", cover: { id: "m_aaaaaaaaaaaa", url: "x" }, at: "2026-01-02T03:04:05+09:00" }, { enforceRequired: true });
    expect(r.issues).toEqual([]);
    expect(r.data).toEqual({ title: "hi", cover: "m_aaaaaaaaaaaa", at: "2026-01-01T18:04:05.000Z", flag: false });
    expect(r.refs.media).toEqual(["m_aaaaaaaaaaaa"]);
  });

  it("下書きでは required を問わないが型は検証する", () => {
    const r = validateData(F, { n: 1.5 }, { enforceRequired: false });
    expect(r.issues).toEqual([expect.objectContaining({ path: "data.n", expected: expect.stringContaining("integer") })]);
  });

  it("公開時は required 欠落を報告する", () => {
    expect(validateData(F, {}, { enforceRequired: true }).issues).toContainEqual(expect.objectContaining({ path: "data.title" }));
  });

  it("未知のフィールドは使えるフィールド一覧つきで報告", () => {
    const r = validateData(F, { titel: "x" }, { enforceRequired: false });
    expect(r.issues[0]).toMatchObject({ path: "data.titel", message: expect.stringContaining("unknown field"), expected: expect.stringContaining("title") });
    expect(r.data).not.toHaveProperty("titel");
  });

  it("maxLength・select・list の入れ子の path", () => {
    const r = validateData(F, { title: "toolong", tags: ["c"], faq: [{ q: "ok" }, {}] }, { enforceRequired: true });
    expect(r.issues.map(i => i.path)).toEqual(["data.title", "data.tags[0]", "data.faq[1].q"]);
  });

  it("オブジェクト以外の入力は data の issue", () => {
    for (const bad of [null, "x", 1, [], undefined]) {
      expect(validateData(F, bad, { enforceRequired: false }).issues).toEqual([
        expect.objectContaining({ path: "data", message: "object required" }),
      ]);
    }
  });

  it("ignoreUnknown では未知キーを報告せず data からも落とす", () => {
    const r = validateData(F, { title: "hi", old: 1, faq: [{ q: "a", gone: 1 }] }, { enforceRequired: true, ignoreUnknown: true });
    expect(r.issues).toEqual([]);
    expect(r.data).toEqual({ title: "hi", faq: [{ q: "a" }], flag: false });
  });

  it("型ごとの不正値を報告する", () => {
    const r = validateData(
      [
        { name: "a", type: "boolean" },
        { name: "b", type: "number", min: 1, max: 3 },
        { name: "c", type: "text" },
        { name: "d", type: "datetime" },
        { name: "e", type: "select", options: ["info", "event"] },
        { name: "f", type: "image" },
        { name: "g", type: "reference", collection: "news" },
        { name: "h", type: "list", fields: [] },
        { name: "i", type: "number" },
      ],
      { a: "true", b: 4, c: 1, d: "not a date", e: "x", f: "abc", g: { id: "m_aaaaaaaaaaaa" }, h: {}, i: Infinity },
      { enforceRequired: false },
    );
    expect(r.issues.map(i => i.path)).toEqual(["data.a", "data.b", "data.c", "data.d", "data.e", "data.f", "data.g", "data.h", "data.i"]);
    expect(r.issues.find(i => i.path === "data.e")?.expected).toBe("one of: info, event");
    expect(r.issues.find(i => i.path === "data.f")?.expected).toContain("m_");
    expect(r.issues.every(i => typeof i.expected === "string" && i.expected.length > 0)).toBe(true);
  });

  it("参照とメディアを refs に集める（list の中も、重複は除く）", () => {
    const fields: FieldDef[] = [
      { name: "author", type: "reference", collection: "people" },
      { name: "cover", type: "image" },
      { name: "items", type: "list", fields: [{ name: "pic", type: "image" }, { name: "ref", type: "reference", collection: "news" }] },
    ];
    const r = validateData(fields, {
      author: { id: "e_aaaaaaaaaaaa" },
      cover: "m_bbbbbbbbbbbb",
      items: [{ pic: "m_bbbbbbbbbbbb", ref: "e_cccccccccccc" }, { pic: "m_dddddddddddd" }],
    }, { enforceRequired: true });
    expect(r.issues).toEqual([]);
    expect(r.data.author).toBe("e_aaaaaaaaaaaa");
    expect(r.refs.media).toEqual(["m_bbbbbbbbbbbb", "m_dddddddddddd"]);
    expect(r.refs.entries).toEqual([
      { collection: "people", id: "e_aaaaaaaaaaaa" },
      { collection: "news", id: "e_cccccccccccc" },
    ]);
  });

  it("select multiple・json・default の扱い", () => {
    const fields: FieldDef[] = [
      { name: "tags", type: "select", options: ["a", "b"], multiple: true },
      { name: "meta", type: "json" },
      { name: "n", type: "number", default: 7 },
      { name: "body", type: "markdown", maxLength: 3 },
    ];
    const ok = validateData(fields, { tags: ["a", "b"], meta: { x: [1, null] }, body: "abc" }, { enforceRequired: true });
    expect(ok.issues).toEqual([]);
    expect(ok.data).toEqual({ tags: ["a", "b"], meta: { x: [1, null] }, n: 7, body: "abc" });
    const bad = validateData(fields, { tags: "a", body: "abcd" }, { enforceRequired: false });
    expect(bad.issues.map(i => i.path)).toEqual(["data.tags", "data.body"]);
  });

  it("datetime は ISO 8601 のみ受け付ける", () => {
    const f: FieldDef[] = [{ name: "at", type: "datetime" }];
    expect(validateData(f, { at: "2026-01-02" }, { enforceRequired: false }).data.at).toBe("2026-01-02T00:00:00.000Z");
    expect(validateData(f, { at: "Jan 2 2026" }, { enforceRequired: false }).issues).toHaveLength(1);
    expect(validateData(f, { at: "2026-13-45" }, { enforceRequired: false }).issues).toHaveLength(1);
    expect(validateData(f, { at: 1767225600000 }, { enforceRequired: false }).issues).toHaveLength(1);
  });

  it("list の要素がオブジェクトでなければ要素の path で報告", () => {
    const r = validateData(F, { faq: [{ q: "a" }, "x"] }, { enforceRequired: true, ignoreUnknown: false });
    expect(r.issues).toContainEqual(expect.objectContaining({ path: "data.faq[1]" }));
  });

  it("null は「クリア」として issue なしで受け付け、data から落とす", () => {
    const fields: FieldDef[] = [
      { name: "cover", type: "image" },
      { name: "meta", type: "json" },
      { name: "n", type: "number" },
      { name: "flag", type: "boolean", default: true },
    ];
    const r = validateData(fields, { cover: null, meta: null, n: null, flag: null }, { enforceRequired: false });
    expect(r.issues).toEqual([]);
    expect(r.data).toEqual({});
  });

  it("required は 欠落・null・空文字・空配列 をすべて欠落として報告する", () => {
    const fields: FieldDef[] = [
      { name: "title", type: "text", required: true },
      { name: "tags", type: "select", options: ["a"], multiple: true, required: true },
      { name: "cover", type: "image", required: true },
    ];
    const r = validateData(fields, { title: "", tags: [], cover: null }, { enforceRequired: true });
    expect(r.issues.map(i => [i.path, i.message])).toEqual([["data.title", "required"], ["data.tags", "required"], ["data.cover", "required"]]);
    // 下書きでは required を問わない（"" は値として保持される）
    const draft = validateData(fields, { title: "", tags: [] }, { enforceRequired: false });
    expect(draft.issues).toEqual([]);
    expect(draft.data).toEqual({ title: "", tags: [] });
  });

  it("datetime はカレンダー上存在しない日付を拒否する", () => {
    const f: FieldDef[] = [{ name: "at", type: "datetime" }];
    for (const bad of ["2026-02-31T00:00:00Z", "2026-02-31", "2026-04-31", "2025-02-29", "2026-00-10", "2026-01-00"]) {
      expect(validateData(f, { at: bad }, { enforceRequired: false }).issues).toHaveLength(1);
    }
    expect(validateData(f, { at: "2024-02-29" }, { enforceRequired: false }).issues).toEqual([]);
  });
});
