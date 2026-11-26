# femtocms

[日本語版 (README.ja.md)](README.ja.md)

femtocms is a CMS with no admin UI. It runs on Cloudflare Workers + D1 + R2 in **your own Cloudflare account**, and you operate it with AI through MCP, with a CLI, or with the HTTP API. Describe what you want ("create a news collection and publish the first announcement") and your AI assistant does it; your website reads the published content with two lines of HTML or a plain `fetch`. It fits the free tier and there is no server to look after.

## Quickstart: news on your landing page in 5 minutes

1. **Deploy it to your Cloudflare account.**

   ```sh
   npx femtocms init
   ```

   This logs in to Cloudflare (a browser window opens), creates the D1 database and the R2 bucket, deploys the Worker, applies the migrations, creates an admin key, and prints everything you need. It is safe to run again.

   > **Before you start:** R2 must be enabled once in the Cloudflare dashboard, and Cloudflare asks for a payment method even for the free tier (you are not charged within the free allowance). If R2 is not enabled yet, `init` prints the dashboard link and waits until you have enabled it.

2. **Connect Claude Code.** Run the `claude mcp add ...` command that `init` printed. It looks like this:

   ```sh
   claude mcp add --transport http femtocms https://femtocms.<your-subdomain>.workers.dev/mcp \
     --header "Authorization: Bearer fcms_admin_..."
   ```

   Any MCP client that can send a custom header (Cursor, Codex, ...) works the same way. The admin key is shown only once: store it in a password manager.

3. **Ask Claude.**

   > Create a news collection and publish the first announcement.
   >
   > (A Japanese request works just as well: 「news コレクションを作って、最初のお知らせを公開して」)

   Claude looks at the existing collections, creates `news` with fields such as `title` and `body`, writes the entry, and publishes it. You can ask for a preview link before publishing.

4. **Paste two lines into your landing page.**

   ```html
   <div data-femtocms="news" data-limit="5"></div>
   <script src="https://femtocms.<your-subdomain>.workers.dev/embed.js" defer></script>
   ```

   The published announcements appear as a plain `<ul>` list (date and title). Style it with the `fcms-*` class names, see [Embed](#embed).

### Without the embed: plain `fetch`

Published entries of a public collection are readable without a key, with CORS enabled. Copy and paste:

```html
<ul id="news"></ul>
<script>
  fetch("https://femtocms.<your-subdomain>.workers.dev/api/news?limit=5&sort=-publishedAt")
    .then((res) => res.json())
    .then(({ items }) => {
      const ul = document.getElementById("news");
      for (const item of items) {
        const li = document.createElement("li");
        li.textContent = `${new Date(item.publishedAt).toLocaleDateString()} ${item.data.title}`;
        ul.appendChild(li);
      }
    });
</script>
```

Use `textContent` (as above), not `innerHTML`, for plain-text fields. Markdown fields come back twice: the source in `data.<field>` and rendered HTML in `html.<field>` (raw HTML inside the Markdown is escaped).

---

## Concepts

### Collections

A collection is a content type, for example `news`, `works`, `faq` or `site`.

| Property | Meaning |
|---|---|
| `name` | Identifier: lowercase letters, digits and hyphens, starting with a letter, up to 40 characters. Cannot be changed later. `collections`, `media`, `trash`, `keys`, `export`, `import`, `reset` and `openapi.json` are reserved. |
| `label` | Display name. |
| `description` | What the collection is for. Written for AI: assistants read it before writing content. |
| `kind` | `list` (many entries, the default) or `single` (exactly one entry, for site settings or LP copy). |
| `public` | Whether published entries can be read without a key (default `true`). |
| `fields` | The field definitions. |

### Fields

Every field has `name` (a letter, then letters, digits or underscores; `id`, `slug` and `status` are reserved), `type`, and optionally `label`, `description` (for AI), `required` and `default`.

| Type | Holds | Options |
|---|---|---|
| `text` | One line of text | `maxLength` |
| `textarea` | Plain multi-line text | `maxLength` |
| `markdown` | Markdown body. Read back as source and as HTML | `maxLength` |
| `number` | A number | `min`, `max`, `integer` |
| `boolean` | true / false | none |
| `datetime` | ISO 8601 date-time | none |
| `select` | One or several choices | `options`, `multiple` |
| `image` | A reference to an uploaded media file. Read back as `{ id, url, width, height, alt, mimeType }` | `multiple` |
| `reference` | A reference to an entry of another collection (read back as its id, or the entry itself with `expand`; `null` when the entry is missing or in the trash) | `collection`, `multiple` |
| `list` | A repeated group of small items (FAQ Q&A, price rows). One level of nesting | `fields` |
| `json` | Free-form JSON (escape hatch) | none |

Changing the schema: adding a field leaves existing entries without a value (or with the `default`); removing a field keeps the stored data but stops returning it; changing a type or name is a remove plus an add, with no automatic conversion.

### Entries, drafts and publishing

An entry has an `id` (`e_...`), an optional `slug`, a `status` (`draft` or `published`), `data` (the field values), and `createdAt`, `updatedAt`, `publishedAt`. Fetch by id or by slug.

- New entries are **drafts**. Types, lengths and ranges are validated on every write, so an AI can fill a draft in step by step.
- **`required` is enforced when you publish**, not when you save a draft. The error lists the missing fields.
- Setting a field to `null` clears it.
- Failed writes return a structured error, `{ "error": { "code", "message", "issues": [{ "path", "message", "expected", "received" }], "hint" } }`, so the caller can fix the input itself.
- Drafts are visible only with an admin key, or with a time-limited preview token (see `preview`).

### Trash

Every delete (entries, media, collections) **moves the item to the trash**. Deleting a collection moves its entries with it. Trashed items disappear from the API, the embed and previews: an image or reference field whose target is missing or in the trash reads as `null` (a `multiple` field leaves it out of the array), and a trashed image's URL returns 404.

- Restore with `trash restore <id>`; the item comes back as it was (draft or published).
- `trash empty` and `trash delete <id>` remove things for good (D1 rows and R2 files) and require the **site name** as confirmation. Items stay in the trash until you empty it.
- The site name is the `--name` you gave `init` (default `femtocms`). `init` prints it, and `GET /` returns it as `site`.
- While an entry is in the trash its slug stays reserved, so it can be restored.

## CLI

`npx femtocms <command>`. Add `--json` to any command for machine-readable output, and `--profile <name>` to pick a saved site.

| Command | What it does |
|---|---|
| `init [--name <name>] [--domain <host>] [--cors-origins <a,b>]` | Deploys femtocms to your Cloudflare account and saves the connection. `--name` (default `femtocms`) names the Worker, D1 database, R2 bucket and the profile, so one account can hold several sites. `--domain` attaches a custom domain (the domain must be on Cloudflare). `--cors-origins` limits which browser origins may call the API (see [Caching](#caching)). Running `init` again keeps the saved `--domain` and `--cors-origins` unless you pass them. |
| `upgrade [--cors-origins <a,b>]` | Applies new database migrations, then deploys the Worker bundled with the installed package. |
| `reset [--confirm <site name>]` | Moves all content (entries, media, collections) to the trash; API keys are kept. Nothing is deleted for good: `trash empty --confirm <site name>` does that. |
| `destroy` | Deletes the Worker, D1 database and R2 bucket (see [Uninstall](#uninstall)). |
| `login --url <url> --key <key> [--name <profile>]` | Saves an existing site on this machine. |
| `logout [--name <profile>]` | Removes a saved profile. |
| `keys create --name <name> [--role admin\|read]` / `keys list` / `keys revoke <id>` | Manage API keys. |
| `collections list \| get <name> \| create \| update <name> \| delete <name>` | Manage schemas. `create` takes `--file` (JSON or YAML), or `--name`, `--label`, `--kind` and repeated `--field name:type[:required]`. |
| `entries list <collection>` | Options `--limit`, `--offset`, `--sort`, `--filter k=v`, `--fields`, `--expand`, `--status draft\|published\|all`. Lists published entries by default. |
| `entries get <collection> [id]` | One entry by id or slug (omit the id for a `single` collection). |
| `entries create <collection>` / `entries update <collection> <id>` | Body from `--data <json>`, `--file post.md` (YAML front matter becomes fields, the body goes to `--body-field`) or `--set k=v`. Also `--slug`, `--published-at <iso>`, `--publish`. |
| `entries delete \| publish \| unpublish <collection> <id>` | Trash, publish, or turn back into a draft. |
| `media upload <file> [--alt <text>] [--filename <name>]` / `media upload --url <url> [--alt <text>] [--filename <name>]` | Upload a local file, or let the server download a URL (up to 20 MB per file). |
| `media update <id> --alt <text>` / `media list` / `media delete <id>` | Change the alt text, list, or trash media. |
| `preview <collection> <id> [--ttl <seconds>]` | Prints a time-limited preview URL for a draft (default 24 hours, up to 2592000 seconds = 30 days). |
| `trash list \| restore <id> \| delete <id> \| empty` | Trash management. `delete` and `empty` take `--confirm <site name>`. |
| `export [--out <dir>]` / `import <dir> [--replace --confirm <site name>]` | Backup and migration, see [Export and import](#export-and-import). |

Connection details are saved in `~/.config/femtocms/config.json` (mode 0600), one profile per site. A `femtocms.json` in the current directory (or a parent) takes precedence, and the environment variables `FEMTOCMS_URL` and `FEMTOCMS_KEY` override both (handy in CI).

## HTTP API

Base: `https://<your-site>/api`, JSON in and out. The machine-readable spec, generated from your current collections, is served at **`/api/openapi.json`**.

- Authenticate with `Authorization: Bearer <key>`. An **admin key** (`fcms_admin_...`) can do everything. A **read key** (`fcms_read_...`) can read the published entries of every collection, private ones included, but not drafts.
- Published entries of public collections need no key.
- Collections: `GET/POST /api/collections`, `GET/PATCH/DELETE /api/collections/:name`.
- Entries: `GET/POST /api/:collection`, `GET/PATCH/DELETE /api/:collection/:idOrSlug`, `POST /api/:collection/:id/publish`, `POST /api/:collection/:id/unpublish`, `POST /api/:collection/:id/preview`. A `single` collection uses `GET/PUT /api/:collection`.
- List parameters: `limit` (default 10, max 100), `offset`, `sort` (`-publishedAt`; the default is newest published first), `filter[field]=value` or `filter[field][gte]=1000` (operators `eq ne lt lte gt gte contains in`), `fields`, `expand` (one level), `status` (`draft`, `published`, `all`; admin only, default `published`). The response is `{ items, total, limit, offset }`.
- Media: `POST /api/media` (multipart `file`, or JSON `{ url }` / `{ base64, filename }`), `GET /api/media`, `PATCH /api/media/:id` (`{ alt }`), `DELETE /api/media/:id`; files are served from `/media/:id/:filename`.
- Trash: `GET /api/trash`, `POST /api/trash/:id/restore`, `DELETE /api/trash/:id?confirm=<site>`, `DELETE /api/trash?confirm=<site>`.
- Admin: `GET/POST/DELETE /api/keys`, `GET /api/export`, `POST /api/import`, `POST /api/reset`.
- `GET /` returns a small JSON description of the site (name, version, API, MCP and OpenAPI URLs).

## MCP tools

The MCP endpoint is `https://<your-site>/mcp` (Streamable HTTP, stateless) and needs an admin key. Destructive tools carry MCP's `destructiveHint` so clients can ask for confirmation.

| Group | Tools |
|---|---|
| Collections | `list_collections`, `get_collection`, `create_collection`, `update_collection`, `delete_collection` |
| Entries | `list_entries`, `get_entry`, `create_entry`, `update_entry`, `delete_entry`, `publish_entry`, `unpublish_entry`, `get_preview_url` |
| Media | `upload_media` (from a URL or base64), `update_media` (alt text), `list_media`, `delete_media` |
| Trash | `list_trash`, `restore_from_trash`, `delete_permanently`, `empty_trash` |
| Keys | `create_key`, `list_keys`, `revoke_key` |
| Data | `export_data`, `import_data`, `reset_site` |

`delete_*` tools only move items to the trash. `delete_permanently`, `empty_trash`, `reset_site` and `import_data` in replace mode require `confirm` set to the site name.

## Embed

```html
<div data-femtocms="news" data-limit="5" data-href="/news/{slug}"></div>
<script src="https://<your-site>/embed.js" defer></script>
```

| Attribute | Meaning |
|---|---|
| `data-femtocms` | Collection name (required). |
| `data-limit` | Number of entries, 1 to 100 (default 5). Newest published first. |
| `data-fields` | Comma-separated fields to show, in order. Default `publishedAt,title`. `publishedAt`, `createdAt` and `updatedAt` are shown as dates. A data field is shown as text when its value is a string or a number (text, textarea, number, datetime, a single select, and the Markdown source), and an image field as an `<img>`; other values (lists, multiple selections, references, JSON) are skipped. |
| `data-href` | Link template such as `/news.html?slug={slug}` or `/news?id={id}`. Without it, items are not links. femtocms does not serve article pages itself; use the [article embed](#article-page) on your own page. |
| `data-locale` | Locale for dates (default: the page's `<html lang>`). |
| `data-empty` | Message shown when there are no entries. |
| `data-filter` | Only entries that match, e.g. `category=menu` or `category=event&price[gte]=1000` (same operators as the API's `filter`: `eq ne lt lte gt gte contains in`). |
| `data-pager` | `pages`: page links under the list, driven by `?page=N` in the page URL (`data-limit` entries per page). `more`: a "Load more" button that appends the next `data-limit` entries. |
| `data-page-param` | URL parameter for `pages` (default `page`). Use different names when a page has two paged lists. |
| `data-prev-label`, `data-next-label`, `data-more-label` | Button texts (defaults follow the locale: `‹ 前へ` / `次へ ›` / `もっと見る` for Japanese, `‹ Prev` / `Next ›` / `Load more` otherwise). |

The script renders `<ul class="fcms-list">` with `<li class="fcms-item">`; links are `.fcms-link`, the title is `.fcms-title`, dates are `<time class="fcms-date">`, other fields are `.fcms-field` plus `.fcms-field-<name>`, images are `.fcms-image`, and the empty message is `.fcms-empty`. Page links are `<nav class="fcms-pager">` with `.fcms-pager-prev`, `.fcms-pager-next`, `.fcms-pager-page`, `.fcms-pager-current` (`aria-current="page"`) and `.fcms-pager-gap` (…); the load-more button is `button.fcms-more`. The built-in CSS is minimal and uses `:where()`, so any rule you write wins. When the script is loaded from another host, set `window.FEMTOCMS_BASE = "https://<your-site>"` first. Call `window.femtocms.refresh()` to render again, for example after inserting new elements.

### Article page

Make one page on your site (for example `news.html`) and paste:

```html
<div data-femtocms-entry="news" data-empty="Article not found"></div>
<script src="https://<your-site>/embed.js" defer></script>
```

and point the list at it with `data-href="news.html?slug={slug}"`. The page reads `?slug=` from its own URL, fetches that published entry and renders `<article class="fcms-entry">` with the title (`<h1 class="fcms-title">`), the date (`<time class="fcms-date">`) and every Markdown field as HTML (`<div class="fcms-body fcms-field-<name>">`).

| Attribute | Meaning |
|---|---|
| `data-femtocms-entry` | Collection name (required). |
| `data-slug` | Show this slug or id instead of reading it from the URL. |
| `data-param` | URL parameter that holds the slug or id (default `slug`). |
| `data-fields` | Fields to show, in order. Default: `title`, `publishedAt`, then every Markdown field. Markdown fields are rendered as HTML, other fields as in the list. |
| `data-heading` | Element for the title: `h1` to `h6` (default `h1`). |
| `data-document-title` | Present: set the page's `<title>` to `<article title> \| <current title>`. |
| `data-locale` | Locale for dates. |
| `data-empty` | Message shown when the entry does not exist, is a draft, or no slug was given. |

Drafts are not shown. To check a draft on your real page design, add the token from `femtocms preview` (or the MCP tool `get_preview_url`) to the page URL: `news.html?slug=<slug>&preview=<token>`. Markdown HTML is produced by the CMS with raw HTML escaped and unsafe links removed; it is the only markup the script inserts. The content is rendered by JavaScript, so search engines may not index it as well as server-rendered pages.

### Templates: your own markup

Put one `<template>` inside a list (`data-femtocms`) or an article page (`data-femtocms-entry`). The script then renders a copy of it for each entry instead of its built-in markup.

```html
<div data-femtocms="news" data-limit="6" data-pager="more">
  <template>
    <a class="card" data-href="news.html?slug={slug}">
      <span class="badge" data-class="category"></span>
      <time data-field="publishedAt"></time>
      <img data-field="thumbnail">
      <h3 data-field="title"></h3>
      <p data-if="author.name">by <span data-field="author.name"></span></p>
    </a>
  </template>
</div>
```

| Attribute | Meaning |
|---|---|
| `data-field="name"` | Fills in the value. Strings and numbers go in as text; multiple selections are joined with ", ". An `<img>` gets the image's `src`, `alt`, `width`, `height` and `loading="lazy"` (attributes written in the template win), and an `<img>` with no image is removed. A `<time>` gets a `datetime` attribute and a readable date. Markdown fields get the HTML the CMS rendered. |
| `data-if="name"` | Removes the element when the value is empty, `false`, `null` or an empty array (`0` is kept). `data-if="!soldOut"` inverts it. |
| `data-class="name …"` | Adds the value as a class: `category-menu` when `category` is `menu`, or just `soldOut` when the value is `true`. Characters other than letters, digits, `_` and `-` are dropped. |
| `data-href="…{name}…"` | Builds the `href`. `{slug}` (falls back to the id), `{id}` and any field name work; values are URL-encoded. Only `http(s)` and relative URLs are set. |
| `<template data-each="name">` | Repeats for each item of a `list` field or a multiple image / reference field. Inside, names refer to that item (nesting works). `data-field="."` is the item itself, e.g. `<img data-field=".">` for an image gallery. |

Names can also be `id`, `slug`, `status`, `publishedAt`, `createdAt` and `updatedAt`. Writing through a reference field, like `author.name`, makes the script add `expand=author` automatically. Only reference fields directly on the entry can be expanded; a reference inside a `list`, or two steps away, comes out empty with a console warning.

Copies go into `<ul class="fcms-items">` when the template's content is an `<li>`, otherwise into `<div class="fcms-items">`; put grid or other layout rules on `.fcms-items`. With a template, the element's `data-fields`, `data-href` and `data-heading` are not used; paging, "load more", `data-filter`, `data-empty` and `data-document-title` work as usual. Values always go in as text, so HTML inside your data is shown as-is and never interpreted.

## Caching

- **workers.dev (default):** public reads get `Cache-Control: public, max-age=60` and an `ETag` (so conditional requests return 304). With only a few entries, reading D1 on every request is fast enough.
- **Custom domain (`init --domain`):** responses are additionally stored in the Cloudflare edge cache. The cache key includes a content version that increases with every write, so stale content is never served and no purge is needed.
- Requests with a key, or with `?preview=`, are `private, no-store`.
- Media files (`/media/...`) are `public, max-age=31536000, immutable`. `embed.js` is cached for 5 minutes.
- CORS for `/api/*` and `/media/*` allows every origin by default. To allow only your own sites, pass `--cors-origins https://www.example.com,https://example.com` to `init` or `upgrade` (the list is saved in the profile and deployed as the Worker's `CORS_ORIGINS` variable; `upgrade` without the flag keeps the saved list, and `--cors-origins ""` allows every origin again). CORS only limits browsers: anyone can still read public content with a non-browser client.

## Export and import

```sh
npx femtocms export --out ./backup          # data.json (schemas, entries, media info) + media/ (the files)
npx femtocms import ./backup                # merge: add or overwrite by id
npx femtocms import ./backup --replace --confirm <site name>   # move existing data to the trash first
```

Entry and media ids are preserved, so references and image URLs keep working in the new deployment. API keys are never exported or imported.

`import` first uploads the files in `media/` (`PUT /api/media/<id>`) and then sends `data.json`, which the server validates as a whole before writing anything to D1. If that validation fails, the uploaded files stay behind under their ids; running the import again overwrites them. With `--replace`, the CLI checks `--confirm` against the site name (`GET /` → `site`) before uploading anything.

## Upgrade

```sh
npx femtocms@latest upgrade
```

Applies any new database migrations, then deploys the Worker bundled with that version of the package to your account.

## Uninstall

```sh
npx femtocms destroy
```

After you type the Worker name, femtocms empties the site (everything is moved to the trash and the trash is emptied, which deletes the R2 files), then deletes the R2 bucket, the Worker and the D1 database, and removes the saved profile. This cannot be undone. Take an `export` first if you may need the data. If the bucket still holds files that belong to no media (for example from an interrupted upload), `destroy` stops before deleting the Worker and the database, keeps the profile, and tells you how to remove those files (`wrangler r2 object delete` or the dashboard) before you run it again. Only the CLI can do this: the running CMS has no permission to manage your Cloudflare account.

## Security notes

- **Keys:** the server stores only the SHA-256 hash of each key. The admin key is shown once, by `init` or `keys create`; keep it secret and out of web pages. The last active admin key cannot be revoked, so an AI cannot lock you out.
- **Public reads are public:** published entries of `public: true` collections (the default) are readable by anyone, which is what lets a landing page call the API from the browser. Put anything private in a collection with `public: false` and read it with a read key from your server, never from the browser.
- **Drafts** are visible only with an admin key or a preview token. Preview tokens are signed, expire (24 hours by default, up to 30 days) and give read access to one entry.
- **Destructive operations** (permanent delete, emptying the trash, reset, replace-import) require the site name as `confirm`; every other delete is recoverable from the trash.
- The CLI sends wrangler its arguments without a shell, and the saved config is readable only by you (0600).

## Requirements

- Node.js 22.12 or later (wrangler requires it).
- A Cloudflare account. Everything runs within the free tier; R2 needs to be enabled once, with a payment method on file.

## License

MIT
