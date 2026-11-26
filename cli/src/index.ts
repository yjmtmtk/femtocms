#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerAdmin } from "./commands/admin";
import { registerContent } from "./commands/content";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("femtocms")
    .description("femtocms の CLI")
    .option("--json", "結果を JSON で出力する")
    .option("--profile <name>", "使うプロファイル名");
  registerAdmin(program);
  registerContent(program);
  return program;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  await buildProgram().parseAsync(process.argv);
}
