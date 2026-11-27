import type { ApiEntry } from "../core/present";
import type { Collection, FieldDef } from "../core/types";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const CSS =
  "body{font:16px/1.7 system-ui,sans-serif;margin:0;color:#222;background:#fff}" +
  ".band{background:#b45309;color:#fff;padding:.5rem 1rem;font-weight:600;position:sticky;top:0}" +
  "main{max-width:48rem;margin:0 auto;padding:1rem}" +
  "h1{font-size:1.3rem}h2{font-size:.85rem;color:#666;margin:1.5rem 0 .25rem;font-weight:600}" +
  ".v{margin:0;overflow-wrap:anywhere}.t{white-space:pre-wrap}.none{color:#999}" +
  "img{max-width:100%;height:auto}pre{background:#f4f4f4;padding:.5rem;overflow:auto;margin:0}";

function renderValue(f: FieldDef, entry: ApiEntry): string {
  const v = Object.hasOwn(entry.data, f.name) ? entry.data[f.name] : undefined;
  if (v === undefined || v === null || v === "") return '<p class="v none">(empty)</p>';
  if (f.type === "markdown" && typeof v === "string") {
    // entry.html is already-sanitized markdown output: the only raw HTML on the page.
    return `<div class="v">${Object.hasOwn(entry.html, f.name) ? entry.html[f.name] : esc(v)}</div>`;
  }
  if (f.type === "image" && isObject(v) && typeof v.url === "string" && /^https?:\/\//i.test(v.url)) {
    return `<p class="v"><img src="${esc(v.url)}" alt="${esc(typeof v.alt === "string" ? v.alt : "")}"></p>`;
  }
  if (typeof v === "string") return `<p class="v t">${esc(v)}</p>`;
  return `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
}

export function renderPreviewPage(collection: Collection, entry: ApiEntry): string {
  const heading = `${collection.label ?? collection.name}${entry.slug ? ` / ${entry.slug}` : ""}`;
  const fields = collection.fields
    .map((f) => `<section><h2>${esc(f.label ?? f.name)}</h2>${renderValue(f, entry)}</section>`)
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(heading)} (preview)</title>` +
    `<style>${CSS}</style></head><body>` +
    `<div class="band">Preview (draft)</div><main><h1>${esc(heading)}</h1>${fields}</main></body></html>`
  );
}
