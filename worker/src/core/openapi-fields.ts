import type { FieldDef } from "./types";

export type JsonSchema = Record<string, unknown>;
export type Direction = "read" | "write";

const MEDIA_ID_PATTERN = "^m_[0-9a-z]{12}$";
const ENTRY_ID_PATTERN = "^e_[0-9a-z]{12}$";

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** The single-value schema of a field (before `multiple` wraps it in an array). */
function baseSchema(f: FieldDef, direction: Direction): JsonSchema {
  const write = direction === "write";
  switch (f.type) {
    case "text":
    case "textarea":
    case "markdown": {
      const s: JsonSchema = { type: "string" };
      if (f.maxLength !== undefined) s.maxLength = f.maxLength;
      if (f.type === "markdown") s.description = "Markdown source. Reads also return the rendered HTML under `html.<field>` (raw HTML in the source is escaped).";
      return s;
    }
    case "number": {
      const s: JsonSchema = { type: f.integer ? "integer" : "number" };
      if (f.min !== undefined) s.minimum = f.min;
      if (f.max !== undefined) s.maximum = f.max;
      return s;
    }
    case "boolean":
      return { type: "boolean" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "select":
      return { type: "string", enum: f.options ?? [] };
    case "image":
      return write
        ? { type: "string", pattern: MEDIA_ID_PATTERN, description: "Media id (m_...). An object with an `id` is also accepted." }
        : { anyOf: [ref("ApiMedia"), { type: "null" }] };
    case "reference":
      return {
        type: "string", pattern: ENTRY_ID_PATTERN,
        description: write
          ? `Entry id (e_...)${f.collection ? ` in "${f.collection}"` : ""}. An object with an \`id\` is also accepted.`
          : `Entry id (e_...)${f.collection ? ` in "${f.collection}"` : ""}. With ?expand=<field> the entry object (or null) is returned instead.`,
      };
    case "list":
      return objectSchema(f.fields ?? [], direction);
    case "json":
      return { description: "Any JSON value." };
  }
}

function objectSchema(fields: FieldDef[], direction: Direction): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, fieldToJsonSchema(f, direction)])),
    ...(direction === "write" ? { additionalProperties: false } : {}),
  };
}

/**
 * JSON Schema (OpenAPI 3.1) for one field.
 * write: ids for image / reference, enum for select, arrays when `multiple`, list -> array of sub-field objects.
 * read: images are ApiMedia objects, references stay id strings, markdown is the source string.
 */
export function fieldToJsonSchema(f: FieldDef, direction: Direction): JsonSchema {
  let schema = baseSchema(f, direction);
  const multiple = f.multiple === true && (f.type === "select" || f.type === "image" || f.type === "reference");
  if (f.type === "list") schema = { type: "array", items: schema };
  else if (multiple) {
    // Missing / trashed media are dropped from read arrays (never null), so elements are not nullable there.
    const items = f.type === "image" && direction === "read" ? ref("ApiMedia") : schema;
    schema = { type: "array", items };
  }
  // The field's own description wins verbatim; the type's generic note is only a fallback.
  if (f.description) schema = { ...schema, description: f.description };
  if (direction === "write" && f.default !== undefined) schema = { ...schema, default: f.default };
  return schema;
}

/** `blog-post` -> `BlogPost`. Used for components/schemas names. */
export function pascalCase(name: string): string {
  return name.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

export { objectSchema, ref };
