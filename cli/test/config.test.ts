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
  it("points to femtocms/config.json under XDG_CONFIG_HOME", () => {
    expect(configPath()).toBe(join(tmp, "xdg", "femtocms", "config.json"));
  });

  it("uses ~/.config when XDG_CONFIG_HOME is not set", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(configPath().endsWith(join(".config", "femtocms", "config.json"))).toBe(true);
  });

  it("returns an empty config when the file does not exist", () => {
    expect(loadConfig()).toEqual({ profiles: {} });
  });

  it("can be saved and read back", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://a", key: "k" } } });
    expect(loadConfig()).toEqual({ current: "a", profiles: { a: { url: "https://a", key: "k" } } });
  });

  it("saves the config file with mode 0600 and the directory with 0700", () => {
    saveConfig({ profiles: { a: { url: "https://a", key: "k" } } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(configPath())).mode & 0o777).toBe(0o700);
  });

  it("keeps mode 0600 when overwritten and leaves no temporary file", () => {
    saveConfig({ profiles: {} });
    saveConfig({ profiles: { a: { url: "https://a", key: "k" } } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(configPath()))).toEqual(["config.json"]);
  });

  it("reports corrupt JSON with a clear error (without including the key)", () => {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), "{ not json");
    expect(() => loadConfig()).toThrow(/config\.json/);
  });
});

describe("resolveProfile", () => {
  const env = {};

  it("environment variables take precedence", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://cfg", key: "cfgkey" } } });
    const r = resolveProfile({
      profile: "a",
      cwd: tmp,
      env: { FEMTOCMS_URL: "https://a", FEMTOCMS_KEY: "k" },
    });
    expect(r.profile).toEqual({ url: "https://a", key: "k" });
  });

  it("a URL alone is not treated as environment configuration", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://cfg", key: "cfgkey" } } });
    const r = resolveProfile({ cwd: tmp, env: { FEMTOCMS_URL: "https://a" } });
    expect(r.name).toBe("a");
  });

  it("--profile takes precedence over femtocms.json and current", () => {
    saveConfig({
      current: "a",
      profiles: { a: { url: "https://a", key: "ka" }, b: { url: "https://b", key: "kb" } },
    });
    writeFileSync(join(tmp, "femtocms.json"), JSON.stringify({ profile: "a" }));
    const r = resolveProfile({ profile: "b", cwd: tmp, env });
    expect(r).toEqual({ name: "b", profile: { url: "https://b", key: "kb" } });
  });

  it("an unknown --profile is an error", () => {
    expect(() => resolveProfile({ profile: "nope", cwd: tmp, env })).toThrow(/nope/);
  });

  it("uses the profile from a femtocms.json in a parent directory", () => {
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

  it("femtocms.json can hold url and key directly", () => {
    writeFileSync(join(tmp, "femtocms.json"), JSON.stringify({ url: "https://x", key: "kx" }));
    const r = resolveProfile({ cwd: tmp, env });
    expect(r.profile).toEqual({ url: "https://x", key: "kx" });
  });

  it("is an error when femtocms.json points to an unknown profile", () => {
    writeFileSync(join(tmp, "femtocms.json"), JSON.stringify({ profile: "ghost" }));
    expect(() => resolveProfile({ cwd: tmp, env })).toThrow(/ghost/);
  });

  it("falls back to current", () => {
    saveConfig({ current: "a", profiles: { a: { url: "https://a", key: "ka" } } });
    expect(resolveProfile({ cwd: tmp, env })).toEqual({
      name: "a",
      profile: { url: "https://a", key: "ka" },
    });
  });

  it("with none of them, errors and points to init / login", () => {
    expect(() => resolveProfile({ cwd: tmp, env })).toThrow(/femtocms init.*femtocms login/);
  });
});
