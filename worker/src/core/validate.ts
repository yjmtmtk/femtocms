import type { Issue } from "./errors";
import type { FieldDef } from "./types";

export interface ValidateResult {
  data: Record<string, unknown>;
  issues: Issue[];
  refs: {
    media: string[];
    entries: { collection: string; id: string }[];
    // Where each ref was written, for issue paths: media by id, entries by `${collection}/${id}`.
    paths: { media: Record<string, string[]>; entries: Record<string, string[]> };
  };
}

// enforceRequired: report missing required fields (publish). ignoreUnknown: skip the "unknown field"
// issue and drop non-schema keys from `data` (for stored data that may predate a schema change).
export interface ValidateOptions {
  enforceRequired: boolean;
  ignoreUnknown?: boolean;
  // Fill missing fields from FieldDef.default (default true). Off for existing entries so a cleared
  // (null) field is not resurrected on the next write.
  applyDefaults?: boolean;
}

const MEDIA_ID_RE = /^m_[0-9a-z]{12}$/;
const ENTRY_ID_RE = /^e_[0-9a-z]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

type Walk = {
  opts: ValidateOptions;
  issues: Issue[];
  refs: ValidateResult["refs"];
};

// A checker returns the normalized value, or `undefined` after pushing its own issue.
type Checker = (f: FieldDef, v: unknown, path: string, w: Walk) => unknown;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(w: Walk, path: string, message: string, expected: string, received?: unknown): undefined {
  w.issues.push(received === undefined ? { path, message, expected } : { path, message, expected, received });
  return undefined;
}

function rangeText(f: FieldDef): string {
  const parts: string[] = [];
  if (f.min !== undefined) parts.push(`>= ${f.min}`);
  if (f.max !== undefined) parts.push(`<= ${f.max}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

const stringExpected = (f: FieldDef) => (f.maxLength !== undefined ? `string (max ${f.maxLength} chars)` : "string");
const numberExpected = (f: FieldDef) => `${f.integer ? "integer" : "number"}${rangeText(f)}`;
const selectExpected = (f: FieldDef) => `one of: ${(f.options ?? []).join(", ")}`;
const imageExpected = () => "media id (m_...) or { id }";
const referenceExpected = (f: FieldDef) => `entry id (e_...) or { id }${f.collection ? ` in "${f.collection}"` : ""}`;
const listExpected = (f: FieldDef) => `array of objects (fields: ${(f.fields ?? []).map(c => c.name).join(", ")})`;
const DATETIME_EXPECTED = "ISO 8601 datetime string (e.g. 2026-01-02T03:04:05Z)";

const text: Checker = (f, v, path, w) => {
  if (typeof v !== "string") return fail(w, path, "must be a string", stringExpected(f), v);
  if (f.maxLength !== undefined && v.length > f.maxLength) {
    return fail(w, path, "too long", stringExpected(f), `${v.length} chars`);
  }
  return v;
};

const number: Checker = (f, v, path, w) => {
  const bad = (message: string) => fail(w, path, message, numberExpected(f), v);
  if (typeof v !== "number" || !Number.isFinite(v)) return bad("must be a finite number");
  if (f.integer && !Number.isInteger(v)) return bad("must be an integer");
  if (f.min !== undefined && v < f.min) return bad(`must be >= ${f.min}`);
  if (f.max !== undefined && v > f.max) return bad(`must be <= ${f.max}`);
  return v;
};

const boolean: Checker = (_f, v, path, w) =>
  typeof v === "boolean" ? v : fail(w, path, "must be a boolean", "boolean (true or false)", v);

// Date.parse rolls "2026-02-31" over to March; reject calendar-invalid Y-M-D up front.
function validDatePrefix(s: string): boolean {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const datetime: Checker = (_f, v, path, w) => {
  const t = typeof v === "string" && ISO_RE.test(v) && validDatePrefix(v) ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? fail(w, path, "must be an ISO 8601 datetime", DATETIME_EXPECTED, v) : new Date(t).toISOString();
};

const select: Checker = (f, v, path, w) => {
  const one = (x: unknown, p: string): string | undefined =>
    typeof x === "string" && (f.options ?? []).includes(x) ? x : fail(w, p, "not an allowed option", selectExpected(f), x);
  if (!f.multiple) return one(v, path);
  if (!Array.isArray(v)) return fail(w, path, "must be an array", `array of ${selectExpected(f)}`, v);
  const out = v.map((x, i) => one(x, `${path}[${i}]`));
  return out.every(x => x !== undefined) ? out : undefined;
};

// Accepts an id string or `{ id }` and normalizes to the id string. Existence is checked by the caller.
function idOf(v: unknown): unknown {
  return isObject(v) ? v.id : v;
}

const image: Checker = (_f, v, path, w) => {
  const id = idOf(v);
  if (typeof id !== "string" || !MEDIA_ID_RE.test(id)) {
    return fail(w, path, "must be a media id", imageExpected(), v);
  }
  if (!w.refs.media.includes(id)) w.refs.media.push(id);
  (w.refs.paths.media[id] ??= []).push(path);
  return id;
};

const reference: Checker = (f, v, path, w) => {
  const id = idOf(v);
  if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) {
    return fail(w, path, "must be an entry id", referenceExpected(f), v);
  }
  const collection = f.collection ?? "";
  if (!w.refs.entries.some(e => e.collection === collection && e.id === id)) w.refs.entries.push({ collection, id });
  (w.refs.paths.entries[`${collection}/${id}`] ??= []).push(path);
  return id;
};

const list: Checker = (f, v, path, w) => {
  if (!Array.isArray(v)) return fail(w, path, "must be an array", listExpected(f), v);
  const before = w.issues.length;
  const out = v.map((item, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(item)) return fail(w, p, "must be an object", listExpected(f), item);
    return walkObject(f.fields ?? [], item, p, w);
  });
  return w.issues.length === before ? out : undefined;
};

const json: Checker = (_f, v) => v;

const CHECKERS: Record<FieldDef["type"], Checker> = {
  text, textarea: text, markdown: text, number, boolean, datetime, select, image, reference, list, json,
};

function walkObject(fields: FieldDef[], input: Record<string, unknown>, path: string, w: Walk): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const names = fields.map(f => f.name);

  if (!w.opts.ignoreUnknown) {
    for (const key of Object.keys(input)) {
      if (!names.includes(key)) {
        w.issues.push({
          path: `${path}.${key}`,
          message: `unknown field "${key}"`,
          expected: `one of: ${names.join(", ")}`,
        });
      }
    }
  }

  for (const f of fields) {
    const p = `${path}.${f.name}`;
    let v = Object.hasOwn(input, f.name) ? input[f.name] : undefined;
    if (v === undefined && f.default !== undefined && w.opts.applyDefaults !== false) v = structuredClone(f.default);
    // Missing / null / "" / [] all count as "no value" for required. null also means "clear this
    // field" (R8): accepted without an issue and omitted from `data`.
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty && f.required && w.opts.enforceRequired) {
      w.issues.push({ path: p, message: "required", expected: expectedOf(f) });
      continue;
    }
    if (v === undefined || v === null) continue;
    const checked = CHECKERS[f.type](f, v, p, w);
    if (checked !== undefined) out[f.name] = checked;
  }
  return out;
}

function expectedOf(f: FieldDef): string {
  switch (f.type) {
    case "text": case "textarea": case "markdown": return stringExpected(f);
    case "number": return numberExpected(f);
    case "boolean": return "boolean (true or false)";
    case "datetime": return DATETIME_EXPECTED;
    case "select": return f.multiple ? `array of ${selectExpected(f)}` : selectExpected(f);
    case "image": return imageExpected();
    case "reference": return referenceExpected(f);
    case "list": return listExpected(f);
    case "json": return "any JSON value";
  }
}

export function validateData(fields: FieldDef[], input: unknown, opts: ValidateOptions): ValidateResult {
  const w: Walk = { opts, issues: [], refs: { media: [], entries: [], paths: { media: {}, entries: {} } } };
  if (!isObject(input)) {
    w.issues.push({ path: "data", message: "object required", expected: "object", received: input });
    return { data: {}, issues: w.issues, refs: w.refs };
  }
  const data = walkObject(fields, input, "data", w);
  return { data, issues: w.issues, refs: w.refs };
}
