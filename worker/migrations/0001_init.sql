CREATE TABLE collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, label TEXT, description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('list','single')), public INTEGER NOT NULL DEFAULT 1,
  fields TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE entries (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id),
  slug TEXT, status TEXT NOT NULL CHECK (status IN ('draft','published')),
  data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT,
  deleted_at TEXT, trashed_with TEXT
);
CREATE UNIQUE INDEX entries_slug ON entries(collection_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX entries_list ON entries(collection_id, deleted_at, status, published_at);
CREATE TABLE media (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
  width INTEGER, height INTEGER, alt TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','read')),
  hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
