import { ApiError } from "./client";

let exit: (code: number) => never = (code) => process.exit(code);

/** Tests replace the exit so printError can be observed without ending the process. */
export function setExit(fn: (code: number) => never): void {
  exit = fn;
}

export function print(result: unknown, opts: { json: boolean; human?: (r: unknown) => string }): void {
  const text = !opts.json && opts.human ? opts.human(result) : JSON.stringify(result, null, 2);
  process.stdout.write(text + "\n");
}

export function printError(err: unknown, opts: { json: boolean }): never {
  const message = err instanceof Error ? err.message : String(err);
  const api = err instanceof ApiError ? err : undefined;

  if (opts.json) {
    const error: Record<string, unknown> = { code: api?.code ?? "cli_error", message };
    if (api?.issues) error.issues = api.issues;
    if (api?.hint) error.hint = api.hint;
    process.stderr.write(JSON.stringify({ error }, null, 2) + "\n");
  } else {
    const lines = [`エラー: ${message}`];
    for (const i of api?.issues ?? []) {
      lines.push(`  ${i.path}: ${i.message}${i.expected ? ` (expected: ${i.expected})` : ""}`);
    }
    if (api?.hint) lines.push(`ヒント: ${api.hint}`);
    process.stderr.write(lines.join("\n") + "\n");
  }
  return exit(api ? 1 : 2);
}
