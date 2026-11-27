import { FemtoError } from "./errors";
import type { Collection, FieldDef, Role } from "./types";

export type ListStatus = "draft" | "published" | "all";

export interface ListParams {
  limit?: number;
  offset?: number;
  sort?: string;
  filter?: Record<string, string | Record<string, string>>;
  fields?: string[];
  expand?: string[];
  status?: ListStatus;
  /** Id or slug of an entry: list what comes after it (or before it) in this sort order. */
  after?: string;
  before?: string;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
// D1 allows at most 100 bound parameters per statement.
const MAX_BINDS = 100;
const MAX_IN_VALUES = 50;

const OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "in"] as const;
type Operator = (typeof OPERATORS)[number];

const csv = (v: string): string[] => v.split(",").map(s => s.trim()).filter(Boolean);

function badInt(name: string, v: string): FemtoError {
  return new FemtoError("bad_request", `${name} must be an integer (received "${v}")`, {
    hint: `Use a form like ${name}=10.`,
  });
}

/** Parses `limit/offset/sort/filter[...]/fields/expand/status/after/before` from a query string. Values are not validated against a schema here. */
export function parseListParams(query: URLSearchParams): ListParams {
  const params: ListParams = {};
  const filter = new Map<string, string | Record<string, string>>();

  for (const [key, value] of query) {
    switch (key) {
      case "limit":
      case "offset": {
        if (!/^-?\d+$/.test(value.trim())) throw badInt(key, value);
        params[key] = Number(value);
        break;
      }
      case "sort": params.sort = value; break;
      case "fields": params.fields = csv(value); break;
      case "expand": params.expand = csv(value); break;
      case "after":
      case "before": params[key] = value; break;
      case "status":
        if (value !== "draft" && value !== "published" && value !== "all") {
          throw new FemtoError("bad_request", `Invalid status (received "${value}")`, {
            hint: "status must be one of draft, published, all.",
          });
        }
        params.status = value;
        break;
      default: {
        if (!key.startsWith("filter")) break; // unrelated query params are ignored
        const m = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(key);
        if (!m) {
          throw new FemtoError("bad_request", `Invalid filter format: "${key}"`, {
            hint: "Use filter[field]=value or filter[field][operator]=value.",
          });
        }
        const [, name, op] = m;
        const prev = filter.get(name);
        const ops: Record<string, string> = typeof prev === "string" ? { eq: prev } : { ...prev };
        if (op === undefined && Object.keys(ops).length === 0) filter.set(name, value);
        else {
          ops[op ?? "eq"] = value;
          filter.set(name, ops);
        }
      }
    }
  }
  if (filter.size > 0) params.filter = Object.fromEntries(filter);
  return params;
}

// --- column resolution -------------------------------------------------------------------------

type Kind = "string" | "select" | "id" | "number" | "datetime" | "boolean" | "multi";

interface Column {
  expr: string;
  kind: Kind;
  /** JSON path inside `data` for schema fields (used by json_each). */
  path?: string;
}

const OPS_BY_KIND: Record<Kind, readonly Operator[]> = {
  string: OPERATORS,
  select: ["eq", "ne", "in", "contains"],
  id: ["eq", "ne", "in"],
  number: ["eq", "ne", "lt", "lte", "gt", "gte", "in"],
  datetime: ["eq", "ne", "lt", "lte", "gt", "gte", "in"],
  boolean: ["eq", "ne"],
  multi: ["contains"],
};

const BUILTIN: Record<string, Column> = {
  createdAt: { expr: "created_at", kind: "datetime" },
  updatedAt: { expr: "updated_at", kind: "datetime" },
  publishedAt: { expr: "published_at", kind: "datetime" },
  slug: { expr: "slug", kind: "string" },
};

function fieldKind(f: FieldDef): Kind | null {
  switch (f.type) {
    case "text": case "textarea": case "markdown": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "datetime": return "datetime";
    case "select": return f.multiple ? "multi" : "select";
    case "image": case "reference": return "id";
    default: return null; // list, json
  }
}

function resolveColumns(collection: Collection): Map<string, Column> {
  const cols = new Map<string, Column>();
  for (const f of collection.fields) {
    const kind = fieldKind(f);
    // f.name matches FIELD_NAME_RE (letters, digits, underscore), so it is safe inside a JSON path literal.
    if (kind) cols.set(f.name, { expr: `json_extract(data, '$.${f.name}')`, kind, path: `$.${f.name}` });
  }
  for (const [name, col] of Object.entries(BUILTIN)) cols.set(name, col); // built-ins win on a name clash
  return cols;
}

const usable = (cols: Map<string, Column>) => `Available fields: ${[...cols.keys()].join(", ")}.`;

function unknownField(name: string, cols: Map<string, Column>, what: "filter" | "sort"): FemtoError {
  return new FemtoError("bad_request", `Field cannot be used in ${what}: "${name}"`, {
    hint: `${usable(cols)} Fields of type list or json cannot be used.`,
  });
}

function column(cols: Map<string, Column>, name: string, what: "filter" | "sort"): Column {
  const col = cols.get(name);
  if (!col) throw unknownField(name, cols, what);
  return col;
}

// --- filters -----------------------------------------------------------------------------------

function convert(kind: Kind, raw: string, name: string): unknown {
  switch (kind) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) {
        throw new FemtoError("bad_request", `"${name}" must be a number (received "${raw}")`, { hint: `filter[${name}]=1000` });
      }
      return n;
    }
    case "boolean":
      if (raw === "true") return 1;
      if (raw === "false") return 0;
      throw new FemtoError("bad_request", `"${name}" must be true or false (received "${raw}")`, { hint: `filter[${name}]=true` });
    case "datetime": {
      const t = Date.parse(raw);
      if (Number.isNaN(t)) {
        throw new FemtoError("bad_request", `"${name}" must be a date-time in ISO 8601 format (received "${raw}")`, {
          hint: `filter[${name}][gte]=2026-01-01T00:00:00Z`,
        });
      }
      return new Date(t).toISOString();
    }
    default: return raw;
  }
}

const SQL_OP: Record<"eq" | "lt" | "lte" | "gt" | "gte", string> = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

function condition(col: Column, op: Operator, raw: string, name: string, binds: unknown[]): string {
  if (!OPS_BY_KIND[col.kind].includes(op)) {
    throw new FemtoError("bad_request", `Operator "${op}" cannot be used with "${name}"`, {
      hint: `Operators available for "${name}": ${OPS_BY_KIND[col.kind].join(", ")}.`,
    });
  }
  const { expr } = col;
  switch (op) {
    case "ne":
      binds.push(convert(col.kind, raw, name));
      return `(${expr} IS NULL OR ${expr} != ?)`;
    case "in": {
      const values = csv(raw);
      if (values.length === 0 || values.length > MAX_IN_VALUES) {
        throw new FemtoError("bad_request", `in for "${name}" needs 1 to ${MAX_IN_VALUES} comma-separated values`, {
          hint: `filter[${name}][in]=a,b,c`,
        });
      }
      for (const v of values) binds.push(convert(col.kind, v, name));
      return `${expr} IN (${values.map(() => "?").join(", ")})`;
    }
    case "contains":
      if (col.kind === "multi") {
        binds.push(raw);
        return `EXISTS (SELECT 1 FROM json_each(entries.data, '${col.path}') WHERE value = ?)`;
      }
      binds.push(`%${likeEscape(raw)}%`);
      return `${expr} LIKE ? ESCAPE '\\'`;
    default:
      binds.push(convert(col.kind, raw, name));
      return `${expr} ${SQL_OP[op]} ?`;
  }
}

function filterClauses(cols: Map<string, Column>, filter: NonNullable<ListParams["filter"]>, binds: unknown[]): string[] {
  const out: string[] = [];
  for (const [name, spec] of Object.entries(filter)) {
    const col = column(cols, name, "filter");
    const ops = typeof spec === "string" ? { eq: spec } : spec;
    for (const [op, raw] of Object.entries(ops)) {
      if (!(OPERATORS as readonly string[]).includes(op)) {
        throw new FemtoError("bad_request", `Unknown operator: "${op}"`, { hint: `Available operators: ${OPERATORS.join(", ")}.` });
      }
      out.push(condition(col, op as Operator, String(raw), name, binds));
    }
  }
  return out;
}

// --- sorting -----------------------------------------------------------------------------------

// Nulls always sort last, whatever the direction. The trailing `id` makes the order total, so pages and
// after / before cursors are stable even when every other key ties.
interface OrderKey { expr: string; desc: boolean }
const DEFAULT_KEYS: OrderKey[] = [{ expr: "published_at", desc: true }, { expr: "created_at", desc: true }];

function orderKeys(cols: Map<string, Column>, sort: string | undefined): OrderKey[] {
  const keys = sort ? csv(sort) : [];
  const parts = keys.length === 0 ? DEFAULT_KEYS : keys.map(key => {
    const desc = key.startsWith("-");
    const name = desc ? key.slice(1) : key;
    const col = column(cols, name, "sort");
    if (col.kind === "multi") {
      throw new FemtoError("bad_request", `"${name}" is a multi-select field and cannot be used in sort`, { hint: usable(cols) });
    }
    return { expr: col.expr, desc };
  });
  return [...parts, { expr: "id", desc: false }];
}

// `reverse` walks the same order backwards (nulls first), for `before`.
function orderSql(keys: OrderKey[], reverse: boolean): string {
  return keys.map(k => `${k.expr} IS NULL${reverse ? " DESC" : ""}, ${k.expr} ${k.desc !== reverse ? "DESC" : "ASC"}`).join(", ");
}

/**
 * Rows strictly after (or before) the cursor row in the order of `keys`, given the cursor's value for each key:
 * k0 beyond v0, or k0 = v0 and (k1 beyond v1, or k1 = v1 and (...)). The last key (id) is unique, so the chain ends there.
 */
function cursorClause(keys: OrderKey[], values: unknown[], dir: "after" | "before", binds: unknown[]): string {
  const forward = dir === "after";
  const step = (i: number): string => {
    const { expr, desc } = keys[i];
    const v = values[i];
    let beyond: string;
    let same: string;
    if (v === null || v === undefined) {
      // Nulls are last: nothing non-null comes after a null, everything non-null comes before it.
      beyond = forward ? "0" : `${expr} IS NOT NULL`;
      same = `${expr} IS NULL`;
    } else {
      const op = desc === forward ? "<" : ">";
      beyond = forward ? `(${expr} IS NULL OR ${expr} ${op} ?)` : `(${expr} IS NOT NULL AND ${expr} ${op} ?)`;
      same = `${expr} = ?`;
      binds.push(v);
    }
    if (i === keys.length - 1) return beyond;
    if (v !== null && v !== undefined) binds.push(v); // for `same`, which follows `beyond` in the SQL
    return `(${beyond} OR (${same} AND ${step(i + 1)}))`;
  };
  return step(0);
}

/** The cursor row's values for each order key, read with this query (binds: collection id, id or slug, id or slug). */
export function cursorLookup(collection: Collection, params: ListParams, role: Role): { sql: string; keys: number } | null {
  if (params.after === undefined && params.before === undefined) return null;
  const keys = orderKeys(resolveColumns(collection), params.sort);
  // Readers who only see published entries cannot use a draft as a cursor (its position would leak).
  const visible = role === "admin" ? "" : " AND status = 'published'";
  return {
    sql: `SELECT ${keys.map((k, i) => `${k.expr} AS k${i}`).join(", ")} FROM entries ` +
      `WHERE collection_id = ? AND deleted_at IS NULL AND (id = ? OR slug = ?)${visible} LIMIT 1`,
    keys: keys.length,
  };
}

// --- builder -----------------------------------------------------------------------------------

export interface ListQuery {
  /** Page query. `LIMIT`/`OFFSET` are already-clamped integers inlined into the SQL; only `binds` are bound. */
  sql: string;
  countSql: string;
  binds: unknown[];
  limit: number;
  offset: number;
  /** `before`: the rows come nearest-first and must be reversed into list order. */
  reversed: boolean;
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** `cursorValues`: the after / before entry's value for each order key (from cursorLookup); required when either is set. */
export function buildListQuery(collection: Collection, params: ListParams, role: Role, cursorValues?: unknown[]): ListQuery {
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const requested = params.status ?? "published";
  if (requested !== "draft" && requested !== "published" && requested !== "all") {
    throw new FemtoError("bad_request", `Invalid status: "${String(requested)}"`, { hint: "status must be one of draft, published, all." });
  }
  // Non-admin roles only ever see published entries, whatever they ask for.
  const status = role === "admin" ? requested : "published";

  const cols = resolveColumns(collection);
  const binds: unknown[] = [collection.id];
  const where = ["collection_id = ?", "deleted_at IS NULL"];
  if (status !== "all") {
    where.push("status = ?");
    binds.push(status);
  }
  where.push(...filterClauses(cols, params.filter ?? {}, binds));
  const keys = orderKeys(cols, params.sort);
  const dir = params.after !== undefined ? "after" : params.before !== undefined ? "before" : null;
  if (dir) {
    if (!cursorValues || cursorValues.length !== keys.length) throw new Error("buildListQuery: cursor values missing");
    where.push(cursorClause(keys, cursorValues, dir, binds));
  }
  if (binds.length > MAX_BINDS) {
    throw new FemtoError("bad_request", "Too many filter conditions", { hint: `The total number of values is limited to ${MAX_BINDS - 2}.` });
  }

  const whereSql = where.join(" AND ");
  const reversed = dir === "before";
  return {
    sql: `SELECT * FROM entries WHERE ${whereSql} ORDER BY ${orderSql(keys, reversed)} LIMIT ${limit} OFFSET ${offset}`,
    countSql: `SELECT COUNT(*) AS n FROM entries WHERE ${whereSql}`,
    binds, limit, offset, reversed,
  };
}
