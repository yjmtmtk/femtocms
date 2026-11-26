import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/client";
import { print, printError, setExit } from "../src/output";

let out: string[];
let err: string[];
let exits: number[];

beforeEach(() => {
  out = [];
  err = [];
  exits = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
  setExit((code) => {
    exits.push(code);
    throw new Error("exit");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setExit((code) => process.exit(code));
});

describe("print", () => {
  it("json=true なら整形 JSON", () => {
    print({ a: 1 }, { json: true, human: () => "H" });
    expect(out.join("")).toBe(JSON.stringify({ a: 1 }, null, 2) + "\n");
  });
  it("human があればそれを使う", () => {
    print({ a: 1 }, { json: false, human: () => "H" });
    expect(out.join("")).toBe("H\n");
  });
  it("human が無ければ JSON", () => {
    print({ a: 1 }, { json: false });
    expect(out.join("")).toBe(JSON.stringify({ a: 1 }, null, 2) + "\n");
  });
});

describe("printError", () => {
  const apiErr = new ApiError(422, "validation_failed", "bad", {
    issues: [
      { path: "data.title", message: "required", expected: "string" },
      { path: "data.n", message: "wrong" },
    ],
    hint: "fix it",
  });

  it("ApiError は人間向けに issues と hint を出し、終了コード 1", () => {
    expect(() => printError(apiErr, { json: false })).toThrow("exit");
    expect(exits).toEqual([1]);
    const text = err.join("");
    expect(text).toContain("bad");
    expect(text).toContain("data.title: required (expected: string)");
    expect(text).toContain("data.n: wrong");
    expect(text).not.toContain("data.n: wrong (expected");
    expect(text).toContain("fix it");
    expect(out).toEqual([]);
  });

  it("json=true は標準エラーに {error:{...}}", () => {
    expect(() => printError(apiErr, { json: true })).toThrow("exit");
    const parsed = JSON.parse(err.join(""));
    expect(parsed).toEqual({
      error: {
        code: "validation_failed",
        message: "bad",
        issues: apiErr.issues,
        hint: "fix it",
      },
    });
  });

  it("ApiError 以外は終了コード 2", () => {
    expect(() => printError(new Error("boom"), { json: false })).toThrow("exit");
    expect(exits).toEqual([2]);
    expect(err.join("")).toContain("boom");
  });

  it("Error でない値も扱える", () => {
    expect(() => printError("oops", { json: true })).toThrow("exit");
    expect(JSON.parse(err.join("")).error.message).toBe("oops");
  });
});
