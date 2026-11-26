import { z } from "zod";
import { FemtoError, type Issue } from "./errors";
import { COLLECTION_NAME_RE, FIELD_NAME_RE, RESERVED_COLLECTION_NAMES } from "./ids";
import type { CollectionInput, FieldDef } from "./types";

const FIELD_TYPES = [
  "text", "textarea", "markdown", "number", "boolean", "datetime",
  "select", "image", "reference", "list", "json",
] as const;

// Entry-level keys that field names must not shadow.
const RESERVED_FIELD_NAMES = ["id", "slug", "status"];

const fieldSchema = z.strictObject({
  name: z.string().regex(FIELD_NAME_RE, "フィールド名は英字で始まり、英数字とアンダースコアで40文字以内にしてください"),
  type: z.enum(FIELD_TYPES),
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  maxLength: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  multiple: z.boolean().optional(),
  collection: z.string().optional(),
  get fields() {
    return z.array(fieldSchema).optional();
  },
});

const baseShape = {
  label: z.string().optional(),
  description: z.string().optional(),
  kind: z.enum(["list", "single"]).optional(),
  public: z.boolean().optional(),
};
const nameSchema = z.string().regex(COLLECTION_NAME_RE, "コレクション名は英小文字で始まり、英小文字・数字・ハイフンで40文字以内にしてください");

const createSchema = z.strictObject({ name: nameSchema, ...baseShape, fields: z.array(fieldSchema) });
// `name` is accepted so callers can echo the whole definition back; collections.ts rejects an actual rename.
const updateSchema = z.strictObject({ name: nameSchema.optional(), ...baseShape, fields: z.array(fieldSchema).optional() });

export function pathToString(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    out += typeof seg === "number" ? `[${seg}]` : out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

export function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => {
    const issue: Issue = { path: pathToString(i.path), message: i.message };
    if (i.code === "invalid_type") issue.expected = i.expected;
    else if (i.code === "invalid_value") issue.expected = i.values.map(String).join(" | ");
    return issue;
  });
}

/** Cross-field rules zod's shape check cannot express. `base` is the path prefix of `fields`. */
function checkFields(fields: FieldDef[], base: string, nested: boolean, issues: Issue[]): void {
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const at = (key: string) => `${base}[${i}].${key}`;
    if (seen.has(f.name)) issues.push({ path: at("name"), message: `フィールド名 "${f.name}" が重複しています` });
    seen.add(f.name);
    if (!nested && RESERVED_FIELD_NAMES.includes(f.name)) {
      issues.push({ path: at("name"), message: `フィールド名 "${f.name}" は予約されています`, expected: `${RESERVED_FIELD_NAMES.join(", ")} 以外` });
    }
    if (f.type === "select" && !f.options?.length) {
      issues.push({ path: at("options"), message: "select には options (文字列の配列) が必要です", expected: "string[]" });
    }
    if (f.type === "reference" && !f.collection) {
      issues.push({ path: at("collection"), message: "reference には collection (参照先コレクション名) が必要です", expected: "string" });
    }
    if (f.type === "list") {
      if (!f.fields) {
        issues.push({ path: at("fields"), message: "list には fields (入れ子のフィールド定義) が必要です", expected: "FieldDef[]" });
      } else {
        f.fields.forEach((child, j) => {
          if (child.type === "list") {
            issues.push({ path: `${at("fields")}[${j}].type`, message: "list の中に list は入れ子にできません" });
          }
        });
        checkFields(f.fields, at("fields"), true, issues);
      }
    }
  });
}

export function parseCollectionInput(input: unknown, mode: "create"): CollectionInput;
export function parseCollectionInput(input: unknown, mode: "update"): Partial<CollectionInput>;
export function parseCollectionInput(input: unknown, mode: "create" | "update"): CollectionInput | Partial<CollectionInput> {
  const parsed = (mode === "create" ? createSchema : updateSchema).safeParse(input);
  if (!parsed.success) {
    throw new FemtoError("validation_failed", "コレクション定義が不正です", { issues: zodIssues(parsed.error) });
  }
  const value = parsed.data as Partial<CollectionInput>;
  const issues: Issue[] = [];
  if (value.name !== undefined && RESERVED_COLLECTION_NAMES.includes(value.name)) {
    issues.push({ path: "name", message: `"${value.name}" は予約語のため使えません`, expected: `${RESERVED_COLLECTION_NAMES.join(", ")} 以外` });
  }
  if (value.fields) checkFields(value.fields, "fields", false, issues);
  if (issues.length) throw new FemtoError("validation_failed", "コレクション定義が不正です", { issues });
  return value;
}
