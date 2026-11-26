export type FieldType =
  | "text" | "textarea" | "markdown" | "number" | "boolean" | "datetime"
  | "select" | "image" | "reference" | "list" | "json";

export interface FieldDef {
  name: string;
  type: FieldType;
  label?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  maxLength?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  options?: string[];
  multiple?: boolean;
  collection?: string;
  fields?: FieldDef[];
}

export interface CollectionInput {
  name: string;
  label?: string;
  description?: string;
  kind?: "list" | "single";
  public?: boolean;
  fields: FieldDef[];
}

export interface Collection {
  id: string;
  name: string;
  label: string | null;
  description: string | null;
  kind: "list" | "single";
  public: boolean;
  fields: FieldDef[];
  createdAt: string;
  updatedAt: string;
}

export type Status = "draft" | "published";

export interface EntryRecord {
  id: string;
  collectionId: string;
  slug: string | null;
  status: Status;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface MediaRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  createdAt: string;
}

export type Role = "admin" | "read" | "public";
