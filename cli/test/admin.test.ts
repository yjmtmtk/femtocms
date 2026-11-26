import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config";
import { setExit } from "../src/output";
import { buildProgram } from "../src/index";

const KEY = "fcms_admin_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

let tmp: string;
let savedXdg: string | undefined;
let out: string[];
let err: string[];
let fetchMock: ReturnType<typeof vi.fn>;

async function run(...args: string[]) {
  await buildProgram().parseAsync(["node", "femtocms", ...args]);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "femtocms-admin-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
  setExit((code) => {
    throw new Error(`exit ${code}`);
  });
  fetchMock = vi.fn(async () => Response.json({ items: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setExit((code) => process.exit(code));
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(tmp, { recursive: true, force: true });
});

describe("login", () => {
  it("GET /api/keys で確認し、ホスト名由来の名前で保存して current にする", async () => {
    await run("login", "--url", "https://My-Site.example.com/", "--key", KEY);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://my-site.example.com/api/keys");
    expect(loadConfig()).toEqual({
      current: "my-site-example-com",
      profiles: { "my-site-example-com": { url: "https://My-Site.example.com", key: KEY } },
    });
  });

  it("--name を使え、キー全体は出力せず先頭 16 文字だけ出す", async () => {
    await run("login", "--url", "https://cms.test", "--key", KEY, "--name", "prod");
    expect(loadConfig().current).toBe("prod");
    const all = out.join("") + err.join("");
    expect(all).toContain("prod");
    expect(all).toContain(KEY.slice(0, 16));
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(0, 20));
  });

  it("--json でも鍵は出さない", async () => {
    await run("--json", "login", "--url", "https://cms.test", "--key", KEY, "--name", "prod");
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ profile: "prod", url: "https://cms.test", keyPrefix: KEY.slice(0, 16) });
  });

  it("検証に失敗したら保存せずエラー終了（キーを出さない）", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: "forbidden", message: "管理キーが必要です" } }, { status: 403 }),
    );
    await expect(run("login", "--url", "https://cms.test", "--key", KEY)).rejects.toThrow("exit 1");
    expect(loadConfig()).toEqual({ profiles: {} });
    expect(err.join("")).toContain("管理キーが必要です");
    expect(err.join("") + out.join("")).not.toContain(KEY);
  });

  it("ホスト名が使えない場合でも名前を作る（localhost:8787 など）", async () => {
    await run("login", "--url", "http://localhost:8787", "--key", KEY);
    expect(loadConfig().current).toBe("localhost");
  });
});

describe("logout", () => {
  beforeEach(() => {
    saveConfig({
      current: "a",
      profiles: { a: { url: "https://a", key: KEY }, b: { url: "https://b", key: KEY } },
    });
  });

  it("--name 無しなら current を削除し、current を外す", async () => {
    await run("logout");
    expect(loadConfig()).toEqual({ profiles: { b: { url: "https://b", key: KEY } } });
    expect(out.join("") + err.join("")).not.toContain(KEY);
  });

  it("--name で指定したものを削除し、current はそのまま", async () => {
    await run("logout", "--name", "b");
    expect(loadConfig()).toEqual({ current: "a", profiles: { a: { url: "https://a", key: KEY } } });
  });

  it("未登録の名前はエラー", async () => {
    await expect(run("logout", "--name", "zzz")).rejects.toThrow("exit 2");
    expect(err.join("")).toContain("zzz");
  });

  it("current が無く --name も無ければエラー", async () => {
    saveConfig({ profiles: {} });
    await expect(run("logout")).rejects.toThrow("exit 2");
  });
});
