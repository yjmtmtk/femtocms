import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, resolveProfile, saveConfig } from "../src/config";

let tmp: string;
let savedXdg: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "femtocms-cfg-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(tmp, { recursive: true, force: true });
});

describe("configPath / loadConfig / saveConfig", () => {
  it("XDG_CONFIG_HOME 配下の femtocms/config.json を指す", () => {
    expect(configPath()).toBe(join(tmp, "xdg", "femtocms", "config.json"));
  });

  it("XDG_CONFIG_HOME が無ければ ~/.config を使う", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(configPath().endsWith(join(".config", "femtocms", "config.json"))).toBe(true);
  });

  it("ファイルが無ければ空の設定を返す", () => {
    expect(loadConfig()).toEqual({ profiles: {} });
  });

  it("保存して読み戻せる", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://a", key: "k" } } });
    expect(loadConfig()).toEqual({ current: "a", profiles: { a: { url: "https://a", key: "k" } } });
  });

  it("設定ファイルは 0600、ディレクトリは 0700 で保存される", () => {
    saveConfig({ profiles: { a: { url: "https://a", key: "k" } } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(configPath())).mode & 0o777).toBe(0o700);
  });

  it("上書き保存しても 0600 のままで、一時ファイルを残さない", () => {
    saveConfig({ profiles: {} });
    saveConfig({ profiles: { a: { url: "https://a", key: "k" } } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(configPath()))).toEqual(["config.json"]);
  });

  it("壊れた JSON は分かるエラーにする（キーは含めない）", () => {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), "{ not json");
    expect(() => loadConfig()).toThrow(/config\.json/);
  });
});

describe("resolveProfile", () => {
  const env = {};

  it("環境変数が最優先", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://cfg", key: "cfgkey" } } });
    const r = resolveProfile({
      profile: "a",
      cwd: tmp,
      env: { FEMTOCMS_URL: "https://a", FEMTOCMS_KEY: "k" },
    });
    expect(r.profile).toEqual({ url: "https://a", key: "k" });
  });

  it("URL だけでは環境変数と見なさない", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://cfg", key: "cfgkey" } } });
    const r = resolveProfile({ cwd: tmp, env: { FEMTOCMS_URL: "https://a" } });
    expect(r.name).toBe("a");
  });

  it("--profile は femtocms.json と current より優先される", () => {
    saveConfig({
      current: "a",
      profiles: { a: { url: "https://a", key: "ka" }, b: { url: "https://b", key: "kb" } },
    });
    writeFileSync(join(tmp, "femtocms.json"), JSON.stringify({ profile: "a" }));
    const r = resolveProfile({ profile: "b", cwd: tmp, env });
    expect(r).toEqual({ name: "b", profile: { url: "https://b", key: "kb" } });
  });

  it("未登録の --profile はエラー", () => {
    expect(() => resolveProfile({ profile: "nope", cwd: tmp, env })).toThrow(/nope/);
  });

  it("親ディレクトリの femtocms.json の profile を使う", () => {
    saveConfig({
      current: "a",
      profiles: { a: { url: "https://a", key: "ka" }, b: { url: "https://b", key: "kb" } },
    });
    writeFileSync(join(tmp, "femtocms.json"), JSON.stringify({ profile: "b" }));
    const sub = join(tmp, "sub", "deeper");
    mkdirSync(sub, { recursive: true });
    const r = resolveProfile({ cwd: sub, env });
    expect(r).toEqual({ name: "b", profile: { url: "https://b", key: "kb" } });
  });

  it("femtocms.json に url と key を直接書ける", () => {
    writeFileSync(join(tmp, "femtocms.json"), JSON.stringify({ url: "https://x", key: "kx" }));
    const r = resolveProfile({ cwd: tmp, env });
    expect(r.profile).toEqual({ url: "https://x", key: "kx" });
  });

  it("femtocms.json が未登録の profile を指すとエラー", () => {
    writeFileSync(join(tmp, "femtocms.json"), JSON.stringify({ profile: "ghost" }));
    expect(() => resolveProfile({ cwd: tmp, env })).toThrow(/ghost/);
  });

  it("current にフォールバックする", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://a", key: "ka" } } });
    expect(resolveProfile({ cwd: tmp, env })).toEqual({
      name: "a",
      profile: { url: "https://a", key: "ka" },
    });
  });

  it("どれも無ければ init / login を案内するエラー", () => {
    expect(() => resolveProfile({ cwd: tmp, env })).toThrow(/femtocms init.*femtocms login/);
  });
});
