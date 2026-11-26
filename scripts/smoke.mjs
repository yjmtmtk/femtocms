#!/usr/bin/env node
// End-to-end check against a deployed femtocms site: node scripts/smoke.mjs <url> <admin-key>
// Creates a throwaway collection `smoke-<timestamp>`, walks the main flow, and removes everything it created.
// Only the items this script created are deleted permanently (the rest of the site's trash is left alone).

const [, , rawUrl, key] = process.argv;
if (!rawUrl || !key) {
  console.error("usage: node scripts/smoke.mjs <url> <admin-key>");
  process.exit(2);
}
const base = rawUrl.replace(/\/+$/, "");
const name = `smoke-${Date.now()}`;
let siteName = "";
let collectionId = "";
let entryId = "";
let failed = 0;

const admin = { Authorization: `Bearer ${key}` };

async function call(method, path, { body, auth = true, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(auth ? admin : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function step(label, fn) {
  try {
    const detail = await fn();
    console.log(`OK   ${label}${detail ? `  (${detail})` : ""}`);
    return true;
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}  ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function expectStatus(r, want, what) {
  expect(r.status === want, `${what}: HTTP ${r.status} (expected ${want}) ${r.text.slice(0, 200)}`);
}

// MCP over HTTP is stateless: every request stands alone.
async function mcp(method, params, id) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  expect(res.ok, `MCP ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  // enableJsonResponse -> plain JSON; accept an SSE frame too.
  const payload = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;
  const msg = JSON.parse(payload);
  expect(!msg.error, `MCP ${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

console.log(`femtocms smoke test: ${base}  (collection ${name})\n`);

await step("GET / returns the site description", async () => {
  const r = await call("GET", "/", { auth: false });
  expectStatus(r, 200, "GET /");
  expect(r.json?.name === "femtocms" && typeof r.json.site === "string", `unexpected body: ${r.text.slice(0, 200)}`);
  siteName = r.json.site;
  return `site "${siteName}", version ${r.json.version}`;
});

const ready = siteName !== "";

if (ready) {
  await step("create collection", async () => {
    const r = await call("POST", "/api/collections", {
      body: {
        name,
        label: "Smoke",
        description: "Temporary collection created by scripts/smoke.mjs",
        fields: [
          { name: "title", type: "text", required: true, description: "Headline" },
          { name: "body", type: "markdown", description: "Body" },
        ],
      },
    });
    expectStatus(r, 201, "POST /api/collections");
    collectionId = r.json.id;
    return collectionId;
  });
}

// Without the collection (wrong key, wrong URL) the remaining steps would only repeat the same failure.
if (collectionId) {
  await step("create entry (draft)", async () => {
    const r = await call("POST", `/api/${name}`, { body: { data: { title: "Hello from smoke", body: "**ok**" } } });
    expectStatus(r, 201, `POST /api/${name}`);
    expect(r.json.status === "draft", `status is ${r.json.status}, expected draft`);
    entryId = r.json.id;
    return entryId;
  });

  await step("draft is hidden without a key", async () => {
    const r = await call("GET", `/api/${name}`, { auth: false });
    expectStatus(r, 200, `GET /api/${name}`);
    expect(r.json.total === 0, `expected 0 public entries, got ${r.json.total}`);
  });

  await step("publish entry", async () => {
    const r = await call("POST", `/api/${name}/${entryId}/publish`);
    expectStatus(r, 200, "publish");
    expect(r.json.status === "published", `status is ${r.json.status}`);
  });

  await step("list without a key shows the entry", async () => {
    const r = await call("GET", `/api/${name}`, { auth: false });
    expectStatus(r, 200, `GET /api/${name}`);
    expect(r.json.total === 1 && r.json.items[0]?.id === entryId, `unexpected list: ${r.text.slice(0, 200)}`);
    expect(r.json.items[0].data.title === "Hello from smoke", "title mismatch");
    expect((r.json.items[0].html?.body ?? "").includes("<strong>ok</strong>"), "markdown was not rendered to html");
    const cache = r.headers.get("cache-control");
    expect(cache === "public, max-age=60", `Cache-Control is "${cache}"`);
    return "Cache-Control: public, max-age=60";
  });

  await step("embed.js is served", async () => {
    const r = await call("GET", "/embed.js", { auth: false });
    expectStatus(r, 200, "GET /embed.js");
    expect(r.text.includes("data-femtocms"), "embed.js does not look like the embed script");
  });

  await step("MCP initialize + tools/list", async () => {
    const init = await mcp("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "femtocms-smoke", version: "0" },
    }, 1);
    expect(init.serverInfo?.name === "femtocms", `unexpected serverInfo: ${JSON.stringify(init.serverInfo)}`);
    const list = await mcp("tools/list", {}, 2);
    const names = (list.tools ?? []).map((t) => t.name);
    for (const want of ["list_collections", "create_entry", "publish_entry", "empty_trash"]) {
      expect(names.includes(want), `tool ${want} is missing`);
    }
    return `${names.length} tools`;
  });

  await step("move entry to the trash", async () => {
    const r = await call("DELETE", `/api/${name}/${entryId}`);
    expectStatus(r, 204, "DELETE entry");
    const pub = await call("GET", `/api/${name}`, { auth: false });
    expect(pub.json.total === 0, "trashed entry is still publicly listed");
    const trash = await call("GET", "/api/trash");
    expectStatus(trash, 200, "GET /api/trash");
    expect(trash.json.items.some((i) => i.id === entryId), "entry is not in the trash");
  });
}

// Cleanup runs even after a failure above, and only touches what this script created.
if (collectionId || entryId) {
  await step("clean up (delete collection, remove our items from the trash)", async () => {
    if (collectionId) {
      const d = await call("DELETE", `/api/collections/${name}`);
      expect(d.status === 204 || d.status === 404, `DELETE collection: HTTP ${d.status} ${d.text.slice(0, 200)}`);
    }
    const confirm = encodeURIComponent(siteName);
    for (const id of [entryId, collectionId].filter(Boolean)) {
      const r = await call("DELETE", `/api/trash/${id}?confirm=${confirm}`);
      expect(r.status === 204 || r.status === 404, `permanent delete ${id}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    }
    const trash = await call("GET", "/api/trash");
    expect(!trash.json.items.some((i) => i.id === collectionId || i.id === entryId), "our items are still in the trash");
  });
}

console.log(failed === 0 ? "\nAll steps OK" : `\n${failed} step(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
