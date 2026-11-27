#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerAdmin } from "./commands/admin";
import { registerContent } from "./commands/content";
import { registerDeploy } from "./commands/deploy";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("femtocms")
    .description("femtocms command line interface")
    .option("--json", "Print the result as JSON")
    .option("--profile <name>", "Profile to use");
  registerAdmin(program);
  registerContent(program);
  registerDeploy(program);
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
