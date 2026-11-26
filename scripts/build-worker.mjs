// Builds the worker that `femtocms init` / `upgrade` deploy: dist/worker/index.js, one self-contained file.
//
// `wrangler deploy --dry-run --outdir` bundles worker/src with worker/wrangler.jsonc, whose `rules` turn
// *.client.js into Text modules. Wrangler emits those as extra files (`<hash>-embed.client.js`) imported
// from index.js, but the generated site config deploys with `no_bundle`, so we inline them here as string
// constants and delete the extra files. The self-check at the end fails the build if that did not work.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist", "worker");
const entry = join(outdir, "index.js");

const wranglerPkg = createRequire(import.meta.url).resolve("wrangler/package.json");
const bin = JSON.parse(readFileSync(wranglerPkg, "utf8")).bin;
const wranglerBin = join(dirname(wranglerPkg), typeof bin === "string" ? bin : bin.wrangler);

const fail = (msg) => {
  console.error(`build-worker: ${msg}`);
  process.exit(1);
};

rmSync(outdir, { recursive: true, force: true });
const build = spawnSync(
  process.execPath,
  [wranglerBin, "deploy", "--dry-run", "--outdir", outdir, "--config", join(root, "worker", "wrangler.jsonc")],
  { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
);
if (build.status !== 0 || !existsSync(entry)) {
  process.stderr.write(`${build.stdout}\n${build.stderr}\n`);
  fail(`wrangler の dry-run が失敗しました（終了コード ${build.status}）`);
}

// import EMBED from "./<hash>-embed.client.js";  ->  const EMBED = "<file contents>";
// The import is one line and JSON.stringify yields one line, so source-map line numbers stay valid.
let code = readFileSync(entry, "utf8");
const inlined = [];
code = code.replace(/^import (\w+) from "\.\/([^"\n]+\.client\.js)";$/gm, (_m, name, file) => {
  const source = readFileSync(join(outdir, file), "utf8");
  rmSync(join(outdir, file));
  inlined.push(source);
  return `const ${name} = ${JSON.stringify(source)};`;
});
writeFileSync(entry, code);

// Self-check: the embed script is in the bundle as a string and nothing still imports a sibling file.
const embedSource = readFileSync(join(root, "worker", "src", "public", "embed.client.js"), "utf8");
if (!code.includes(JSON.stringify(embedSource))) fail("dist/worker/index.js に embed.client.js の中身が埋め込まれていません");
if (/from\s+"\.\/[^"]*\.client\.js"/.test(code)) fail("dist/worker/index.js が .client.js を import したままです");
const leftovers = readdirSync(outdir).filter((f) => f.endsWith(".client.js"));
if (leftovers.length > 0) fail(`余分なモジュールが残っています: ${leftovers.join(", ")}`);

console.log(`build-worker: dist/worker/index.js (${(code.length / 1024).toFixed(0)} KiB, ${inlined.length} text module(s) inlined)`);
