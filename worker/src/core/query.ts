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
  return new FemtoError("bad_request", `${name} は整数で指定してください (受け取った値: "${v}")`, {
    hint: `${name}=10 のように指定します`,
  });
}

/** Parses `limit/offset/sort/filter[...]/fields/expand/status` from a query string. Values are not validated against a schema here. */
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
      case "status":
        if (value !== "draft" && value !== "published" && value !== "all") {
          throw new FemtoError("bad_request", `status が不正です (受け取った値: "${value}")`, {
            hint: "status は draft / published / all のいずれかです",
          });
        }
        params.status = value;
        break;
      default: {
        if (!key.startsWith("filter")) break; // unrelated query params are ignored
        const m = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(key);
        if (!m) {
          throw new FemtoError("bad_request", `filter の書式が不正です: "${key}"`, {
            hint: "filter[フィールド名]=値 または filter[フィールド名][演算子]=値 の形で指定します",
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

const usable = (cols: Map<string, Column>) => `使えるフィールド: ${[...cols.keys()].join(", ")}`;

function unknownField(name: string, cols: Map<string, Column>, what: "filter" | "sort"): FemtoError {
  return new FemtoError("bad_request", `${what} に使えないフィールドです: "${name}"`, {
    hint: `${usable(cols)} (list / json 型のフィールドは使えません)`,
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
        throw new FemtoError("bad_request", `"${name}" には数値を指定してください (受け取った値: "${raw}")`, { hint: `filter[${name}]=1000` });
      }
      return n;
    }
    case "boolean":
      if (raw === "true") return 1;
      if (raw === "false") return 0;
      throw new FemtoError("bad_request", `"${name}" には true か false を指定してください (受け取った値: "${raw}")`, { hint: `filter[${name}]=true` });
    case "datetime": {
      const t = Date.parse(raw);
      if (Number.isNaN(t)) {
        throw new FemtoError("bad_request", `"${name}" には ISO 8601 の日時を指定してください (受け取った値: "${raw}")`, {
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
    throw new FemtoError("bad_request", `"${name}" には演算子 "${op}" を使えません`, {
      hint: `"${name}" で使える演算子: ${OPS_BY_KIND[col.kind].join(", ")}`,
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
        throw new FemtoError("bad_request", `"${name}" の in には 1〜${MAX_IN_VALUES} 個の値をカンマ区切りで指定してください`, {
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
        throw new FemtoError("bad_request", `未知の演算子です: "${op}"`, { hint: `使える演算子: ${OPERATORS.join(", ")}` });
      }
      out.push(condition(col, op as Operator, String(raw), name, binds));
    }
  }
  return out;
}

// --- sorting -----------------------------------------------------------------------------------

// Nulls always sort last, whatever the direction. `id` keeps pagination stable.
const nullsLast = (expr: string, dir: "ASC" | "DESC") => `${expr} IS NULL, ${expr} ${dir}`;
const DEFAULT_ORDER = [nullsLast("published_at", "DESC"), "created_at DESC", "id ASC"].join(", ");

function orderBy(cols: Map<string, Column>, sort: string | undefined): string {
  const keys = sort ? csv(sort) : [];
  if (keys.length === 0) return DEFAULT_ORDER;
  const parts = keys.map(key => {
    const desc = key.startsWith("-");
    const name = desc ? key.slice(1) : key;
    const col = column(cols, name, "sort");
    if (col.kind === "multi") {
      throw new FemtoError("bad_request", `"${name}" は複数選択のため sort に使えません`, { hint: usable(cols) });
    }
    return nullsLast(col.expr, desc ? "DESC" : "ASC");
  });
  return [...parts, "id ASC"].join(", ");
}

// --- builder -----------------------------------------------------------------------------------

export interface ListQuery {
  /** Page query. `LIMIT`/`OFFSET` are already-clamped integers inlined into the SQL; only `binds` are bound. */
  sql: string;
  countSql: string;
  binds: unknown[];
  limit: number;
  offset: number;
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function buildListQuery(collection: Collection, params: ListParams, role: Role): ListQuery {
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const requested = params.status ?? "published";
  if (requested !== "draft" && requested !== "published" && requested !== "all") {
    throw new FemtoError("bad_request", `status が不正です: "${String(requested)}"`, { hint: "status は draft / published / all のいずれかです" });
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
  if (binds.length > MAX_BINDS) {
    throw new FemtoError("bad_request", "filter の条件が多すぎます", { hint: `値の合計は ${MAX_BINDS - 2} 個までです` });
  }

  const order = orderBy(cols, params.sort);
  const whereSql = where.join(" AND ");
  return {
    sql: `SELECT * FROM entries WHERE ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    countSql: `SELECT COUNT(*) AS n FROM entries WHERE ${whereSql}`,
    binds, limit, offset,
  };
}
