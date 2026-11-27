// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const script = readFileSync(path.join(import.meta.dirname, "../src/public/embed.client.js"), "utf8");
// The test runs under happy-dom while tsconfig only carries Workers types (lib.dom would clash with them), so DOM globals go through `any`.
const win = globalThis as any;
const document = win.document;

function load(): void {
  new Function(script)();
}
function mockItems(items: unknown[]) {
  const fn = vi.fn(async () => Response.json({ items, total: items.length }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const entry = (over: Record<string, unknown> = {}) => ({
  id: "e_abc123def456", slug: "a", status: "published", createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z", publishedAt: "2026-11-26T00:00:00.000Z", data: { title: "Hello" }, html: {}, ...over,
});

beforeEach(() => {
  win.FEMTOCMS_BASE = "https://cms.test";
  delete win.femtocms;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete win.FEMTOCMS_BASE;
});

it("renders the list, and HTML in a title appears as text", async () => {
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-href="/news/{slug}"></div>`;
  const fetchMock = mockItems([entry({ data: { title: "<b>x</b>" } })]);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news?limit=2&sort=-publishedAt", { credentials: "omit" });
  const a = document.querySelector("a.fcms-link")!;
  expect(a.getAttribute("href")).toBe("/news/a");
  expect(document.querySelector(".fcms-title")!.textContent).toBe("<b>x</b>");
  expect(document.querySelector(".fcms-title")!.innerHTML).not.toContain("<b>");
  expect(document.querySelector("ul.fcms-list > li.fcms-item")).not.toBeNull();
  const time = document.querySelector("time.fcms-date")!;
  expect(time.getAttribute("datetime")).toBe("2026-11-26T00:00:00.000Z");
});

it("limit is clamped to 1-100 with a default of 5; the collection name is URL-encoded", async () => {
  document.body.innerHTML = `
    <div data-femtocms="a b"></div>
    <div data-femtocms="big" data-limit="9999"></div>
    <div data-femtocms="zero" data-limit="0"></div>
    <div data-femtocms="junk" data-limit="abc"></div>`;
  const fetchMock = mockItems([]);
  load();
  await win.femtocms.refresh();
  const urls = fetchMock.mock.calls.map((c) => (c as unknown[])[0]);
  expect(urls).toContain("https://cms.test/api/a%20b?limit=5&sort=-publishedAt");
  expect(urls).toContain("https://cms.test/api/big?limit=100&sort=-publishedAt");
  expect(urls).toContain("https://cms.test/api/zero?limit=1&sort=-publishedAt");
  expect(urls).toContain("https://cms.test/api/junk?limit=5&sort=-publishedAt");
});

it("data-fields: strings and numbers become span, dates become time, images only when listed and only http(s) as img", async () => {
  document.body.innerHTML = `<div data-femtocms="news" data-fields="title,price,cover,evil,flag,missing,updatedAt,bad name!"></div>`;
  mockItems([entry({
    data: {
      title: "T", price: 42, cover: { url: "https://cms.test/media/m_1/a.png", alt: "alt <x>" },
      evil: { url: "javascript:alert(1)", alt: "" }, flag: true, "bad name!": "ok",
    },
  })]);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector(".fcms-title")!.textContent).toBe("T");
  expect(document.querySelector(".fcms-field.fcms-field-price")!.textContent).toBe("42");
  const img = document.querySelector("img.fcms-image")!;
  expect(img.getAttribute("src")).toBe("https://cms.test/media/m_1/a.png");
  expect(img.getAttribute("alt")).toBe("alt <x>");
  expect(img.getAttribute("loading")).toBe("lazy");
  expect(document.querySelectorAll("img").length).toBe(1);
  expect(document.querySelector("time.fcms-date")!.getAttribute("datetime")).toBe("2026-11-25T00:00:00.000Z");
  expect(document.querySelector(".fcms-field-flag")).toBeNull();
  expect(document.querySelector(".fcms-field-missing")).toBeNull();
  expect(document.querySelector(".fcms-field-badname")!.textContent).toBe("ok");
  expect(document.querySelector("[class*='!']")).toBeNull();
});

it("by default, images and arbitrary fields in data are not rendered", async () => {
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  mockItems([entry({ data: { title: "T", cover: { url: "https://cms.test/media/m_1" }, body: "secret" } })]);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector(".fcms-field-body")).toBeNull();
});

it("data-locale changes the display language of dates", async () => {
  document.body.innerHTML = `<div data-femtocms="news" data-locale="en-US"></div>`;
  mockItems([entry({ publishedAt: "2026-11-26T12:00:00.000Z" })]);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("time.fcms-date")!.textContent).toBe(new Date("2026-11-26T12:00:00.000Z").toLocaleDateString("en-US"));
});

it("data-href: also substitutes {id}, falls back to id when there is no slug, and URL-encodes values", async () => {
  document.body.innerHTML = `<div data-femtocms="news" data-href="/n/{slug}?id={id}"></div>`;
  mockItems([entry({ slug: null, id: "e_x y" }), entry({ slug: "a/b" })]);
  load();
  await win.femtocms.refresh();
  const hrefs = [...document.querySelectorAll("a.fcms-link")].map((a) => a.getAttribute("href"));
  expect(hrefs).toEqual(["/n/e_x%20y?id=e_x%20y", "/n/a%2Fb?id=e_abc123def456"]);
});

it("data-href with a dangerous scheme renders without a link", async () => {
  document.body.innerHTML = `
    <div id="a" data-femtocms="news" data-href="javascript:alert('{slug}')"></div>
    <div id="b" data-femtocms="news" data-href=" JaVa&#9;script:alert(1)"></div>
    <div id="c" data-femtocms="news" data-href="data:text/html,x"></div>
    <div id="d" data-femtocms="news" data-href="https://example.com/{slug}"></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  for (const id of ["a", "b", "c"]) {
    expect(document.querySelector(`#${id} a`)).toBeNull();
    expect(document.querySelector(`#${id} li.fcms-item .fcms-title`)!.textContent).toBe("Hello");
  }
  expect(document.querySelector("#d a")!.getAttribute("href")).toBe("https://example.com/a");
});

it("shows data-empty when there are 0 entries; shows nothing when it is not set", async () => {
  document.body.innerHTML = `<div id="a" data-femtocms="news" data-empty="お知らせはありません"></div><div id="b" data-femtocms="news"></div>`;
  mockItems([]);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("#a")!.textContent).toBe("お知らせはありません");
  expect(document.querySelector("#a ul")).toBeNull();
  expect(document.querySelector("#b")!.innerHTML).toBe("");
});

it("on fetch failure, does not throw, leaves the element empty and calls console.warn", async () => {
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  globalThis.fetch = vi.fn(async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  load();
  await expect(win.femtocms.refresh()).resolves.toBeUndefined();
  expect(document.querySelector("[data-femtocms]")!.innerHTML).toBe("");
  expect(warn).toHaveBeenCalledWith("[femtocms]", expect.anything());
});

it("on an HTTP error or an unexpected body, does not throw and leaves the element empty", async () => {
  document.body.innerHTML = `<div id="a" data-femtocms="nope"></div><div id="b" data-femtocms="odd"></div>`;
  globalThis.fetch = vi.fn(async (url: string) =>
    String(url).includes("/nope") ? new Response("{}", { status: 404 }) : Response.json({ nothing: true })) as unknown as typeof fetch;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("#a")!.innerHTML).toBe("");
  expect(document.querySelector("#b")!.innerHTML).toBe("");
  expect(warn).toHaveBeenCalledWith("[femtocms]", expect.objectContaining({ message: expect.stringContaining("HTTP 404") }));
  expect(warn).toHaveBeenCalledWith("[femtocms]", expect.objectContaining({ message: expect.stringContaining("unexpected response") }));
});

it("style is injected only once, and every selector uses :where for specificity 0", async () => {
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  await win.femtocms.refresh();
  const styles = document.querySelectorAll("style#fcms-style");
  expect(styles.length).toBe(1);
  const css = styles[0].textContent!;
  const selectors = css.replace(/\{[^}]*\}/g, "|").split("|").map((s: string) => s.trim()).filter(Boolean);
  expect(selectors.length).toBeGreaterThan(0);
  for (const s of selectors) expect(s).toMatch(/^:where\(.+\)$/);
});

it("calling refresh repeatedly does not duplicate the list", async () => {
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  mockItems([entry(), entry({ id: "e_2", slug: "b" })]);
  load();
  await Promise.all([win.femtocms.refresh(), win.femtocms.refresh()]);
  await win.femtocms.refresh();
  expect(document.querySelectorAll("li.fcms-item").length).toBe(2);
  expect(document.querySelectorAll("ul.fcms-list").length).toBe(1);
});

it("elements added later are also rendered by refresh", async () => {
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  await win.femtocms.refresh();
  expect(document.querySelectorAll("li.fcms-item").length).toBe(1);
});

it("the only global added is window.femtocms", async () => {
  const before = new Set(Object.getOwnPropertyNames(win));
  load();
  const added = Object.getOwnPropertyNames(win).filter((k) => !before.has(k));
  expect(added).toEqual(["femtocms"]);
});

it("when the base URL cannot be determined, only warns and does nothing", async () => {
  delete win.FEMTOCMS_BASE;
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  const fetchMock = mockItems([entry()]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  load();
  await win.femtocms.refresh();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalled();
});

// ---- Detail view: [data-femtocms-entry] ----

function setPageUrl(url: string): void {
  if (win.happyDOM?.setURL) win.happyDOM.setURL(url);
  else win.history.replaceState({}, "", url);
}
function mockEntry(body: unknown, status = 200) {
  const fn = vi.fn(async () => Response.json(body, { status }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const detail = entry({
  slug: "winter-latte",
  data: { title: "<i>冬</i>のラテ", body: "**md**", cover: { url: "https://cms.test/media/m_x/a.png", alt: "ラテ" } },
  html: { body: "<p><strong>md</strong></p>" },
});

it("detail: fetches the entry for ?slug= in the URL and renders title, date and body HTML into an article", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.body.innerHTML = `<div data-femtocms-entry="news"></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news/winter-latte", { credentials: "omit" });
  const article = document.querySelector("article.fcms-entry")!;
  expect(article).not.toBeNull();
  const h1 = article.querySelector("h1.fcms-title")!;
  expect(h1.textContent).toBe("<i>冬</i>のラテ");
  expect(h1.innerHTML).not.toContain("<i>");
  expect(article.querySelector("time.fcms-date")!.getAttribute("datetime")).toBe("2026-11-26T00:00:00.000Z");
  const body = article.querySelector(".fcms-body.fcms-field-body")!;
  expect(body.innerHTML).toBe("<p><strong>md</strong></p>");
  // images and the like are not rendered by default
  expect(article.querySelector("img")).toBeNull();
});

it("detail: data-slug takes precedence over the URL, and the slug is URL-encoded", async () => {
  setPageUrl("https://lp.test/news.html?slug=ignored");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-slug="a b/c"></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news/a%20b%2Fc", { credentials: "omit" });
});

it("detail: data-param changes the URL parameter name", async () => {
  setPageUrl("https://lp.test/news.html?id=e_abc123def456");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-param="id"></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news/e_abc123def456", { credentials: "omit" });
});

it("detail: passes the preview token from the page URL to the API (a draft can be checked in the landing page's design)", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte&preview=tok.en");
  document.body.innerHTML = `<div data-femtocms-entry="news"></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news/winter-latte?preview=tok.en", { credentials: "omit" });
});

it("detail: data-fields and data-heading change the fields and the heading element; images only when listed and only http(s)", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-fields="cover,title" data-heading="h2"></div>`;
  mockEntry(detail);
  load();
  await win.femtocms.refresh();
  const article = document.querySelector("article.fcms-entry")!;
  expect(article.children[0].tagName).toBe("IMG");
  expect(article.children[0].getAttribute("alt")).toBe("ラテ");
  expect(article.querySelector("h2.fcms-title")!.textContent).toBe("<i>冬</i>のラテ");
  expect(article.querySelector(".fcms-body")).toBeNull();
});

it("detail: a data-heading that is not a heading falls back to h1", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-heading="script"></div>`;
  mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("script.fcms-title")).toBeNull();
  expect(document.querySelector("h1.fcms-title")).not.toBeNull();
});

it("detail: shows data-empty on a 404, or when no slug is given and the collection is a list, and does not throw", async () => {
  setPageUrl("https://lp.test/news.html?slug=nope");
  document.body.innerHTML = `
    <div id="a" data-femtocms-entry="news" data-empty="記事が見つかりません"></div>`;
  mockEntry({ error: { code: "not_found", message: "x" } }, 404);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("#a .fcms-empty")!.textContent).toBe("記事が見つかりません");

  setPageUrl("https://lp.test/news.html");
  document.body.innerHTML = `<div id="b" data-femtocms-entry="news" data-empty="記事が見つかりません"></div>`;
  const fetchMock = mockEntry({ items: [detail], total: 1, limit: 1, offset: 0 });
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news?limit=1", { credentials: "omit" });
  expect(document.querySelector("#b .fcms-empty")!.textContent).toBe("記事が見つかりません");
  expect(document.querySelector("#b article")).toBeNull();
});

it("detail: data-document-title sets the page title to the entry title", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.title = "Café";
  document.body.innerHTML = `<div data-femtocms-entry="news" data-document-title></div>`;
  mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(document.title).toBe("<i>冬</i>のラテ | Café");
});

it("renders both a list and a detail on the same page", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.body.innerHTML = `<div data-femtocms="news"></div><div data-femtocms-entry="news"></div>`;
  globalThis.fetch = vi.fn(async (url: string) =>
    Response.json(String(url).includes("/api/news/") ? detail : { items: [entry()], total: 1 })) as unknown as typeof fetch;
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("ul.fcms-list")).not.toBeNull();
  expect(document.querySelector("article.fcms-entry")).not.toBeNull();
});

// ---- Paging and filtering ----

function mockPaged(total: number) {
  const fn = vi.fn(async (url: string) => {
    const u = new URL(String(url));
    const limit = Number(u.searchParams.get("limit"));
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const items = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) items.push(entry({ id: `e_${String(i).padStart(12, "0")}`, slug: `s${i}`, data: { title: `T${i}` } }));
    return Response.json({ items, total, limit, offset });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const titles = () => [...document.querySelectorAll(".fcms-title")].map((n: any) => n.textContent);

it("converts data-filter to filter[...] and passes it to the API", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-filter="category=menu&price[gte]=1000"></div>`;
  const fetchMock = mockItems([]);
  load();
  await win.femtocms.refresh();
  const u = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
  expect(u.searchParams.get("filter[category]")).toBe("menu");
  expect(u.searchParams.get("filter[price][gte]")).toBe("1000");
});

it("pages: derives offset from ?page= in the URL and renders a page-number nav", async () => {
  setPageUrl("https://lp.test/news-list.html?page=2&x=1");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="3" data-pager="pages"></div>`;
  const fetchMock = mockPaged(11);
  load();
  await win.femtocms.refresh();
  const u = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
  expect(u.searchParams.get("offset")).toBe("3");
  expect(titles()).toEqual(["T3", "T4", "T5"]);
  const nav = document.querySelector("nav.fcms-pager")!;
  expect(nav).not.toBeNull();
  const current = nav.querySelector("[aria-current=page]")!;
  expect(current.textContent).toBe("2");
  const hrefs = [...nav.querySelectorAll("a")].map((a: any) => a.getAttribute("href"));
  expect(hrefs).toContain("?page=1&x=1"); // previous and 1
  expect(hrefs).toContain("?page=3&x=1"); // next and 3
  expect(hrefs).toContain("?page=4&x=1");
  expect(nav.querySelector(".fcms-pager-prev")).not.toBeNull();
  expect(nav.querySelector(".fcms-pager-next")).not.toBeNull();
});

it("pages: no \"previous\" on the first page, no \"next\" on the last page, and no nav when there is only one page", async () => {
  setPageUrl("https://lp.test/list.html");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="3" data-pager="pages"></div>`;
  mockPaged(11);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector(".fcms-pager-prev")).toBeNull();
  expect(document.querySelector(".fcms-pager-next")).not.toBeNull();

  setPageUrl("https://lp.test/list.html?page=4");
  await win.femtocms.refresh();
  expect(titles()).toEqual(["T9", "T10"]);
  expect(document.querySelector(".fcms-pager-next")).toBeNull();

  setPageUrl("https://lp.test/list.html");
  mockPaged(2);
  await win.femtocms.refresh();
  expect(document.querySelector("nav.fcms-pager")).toBeNull();
});

it("pages: with many pages, shows only the neighbors and abbreviates with …; an invalid page is treated as 1", async () => {
  setPageUrl("https://lp.test/list.html?page=10");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="1" data-pager="pages"></div>`;
  mockPaged(20);
  load();
  await win.femtocms.refresh();
  const labels = [...document.querySelectorAll(".fcms-pager-page, .fcms-pager-gap")].map((n: any) => n.textContent);
  expect(labels).toEqual(["1", "…", "9", "10", "11", "…", "20"]);

  setPageUrl("https://lp.test/list.html?page=abc");
  const fetchMock = mockPaged(20);
  await win.femtocms.refresh();
  expect(new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get("offset")).toBe("0");
});

it("pages: data-page-param changes the URL parameter name, and an out-of-range page shows data-empty", async () => {
  setPageUrl("https://lp.test/list.html?p=9");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="3" data-pager="pages" data-page-param="p" data-empty="ありません"></div>`;
  mockPaged(5);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector(".fcms-empty")!.textContent).toBe("ありません");
  const hrefs = [...document.querySelectorAll("nav.fcms-pager a")].map((a: any) => a.getAttribute("href"));
  expect(hrefs).toContain("?p=1");
});

it("more: \"Load more\" appends the next entries and removes the button once everything is loaded", async () => {
  setPageUrl("https://lp.test/");
  document.documentElement.lang = "ja";
  document.body.innerHTML = `<div data-femtocms="news" data-limit="4" data-pager="more"></div>`;
  const fetchMock = mockPaged(10);
  load();
  await win.femtocms.refresh();
  expect(titles()).toEqual(["T0", "T1", "T2", "T3"]);
  const btn = document.querySelector("button.fcms-more")!;
  expect(btn.textContent).toBe("もっと見る");
  expect(btn.getAttribute("type")).toBe("button");
  await win.femtocms.more(document.querySelector("[data-femtocms]"));
  expect(titles()).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
  // the script also renders once on load, so look at the latest call
  expect(new URL(String((fetchMock.mock.calls.at(-1) as unknown[])[0])).searchParams.get("offset")).toBe("4");
  await win.femtocms.more(document.querySelector("[data-femtocms]"));
  expect(titles().length).toBe(10);
  expect(document.querySelector("button.fcms-more")).toBeNull();
  expect(document.querySelectorAll("ul.fcms-list").length).toBe(1);
  document.documentElement.lang = "";
});

it("more: clicking the button loads more, and data-more-label changes the label", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="more" data-more-label="Load more news"></div>`;
  mockPaged(3);
  load();
  await win.femtocms.refresh();
  const btn = document.querySelector("button.fcms-more")!;
  expect(btn.textContent).toBe("Load more news");
  btn.click();
  await vi.waitFor(() => expect(titles()).toEqual(["T0", "T1", "T2"]));
  expect(document.querySelector("button.fcms-more")).toBeNull();
});

it("more: no button when everything fits on one page; on fetch failure the button stays and nothing throws", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="5" data-pager="more"></div>`;
  mockPaged(3);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("button.fcms-more")).toBeNull();

  mockPaged(8);
  await win.femtocms.refresh();
  expect(document.querySelector("button.fcms-more")).not.toBeNull();
  globalThis.fetch = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await win.femtocms.more(document.querySelector("[data-femtocms]"));
  const btn = document.querySelector("button.fcms-more")!;
  expect(btn).not.toBeNull();
  expect(btn.hasAttribute("disabled")).toBe(false);
  expect(titles().length).toBe(5);
});

// ---- Templates: <template> lets you decide the look freely ----

const q = (sel: string) => document.querySelector(sel) as any;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as any[];

it("template: clones the list per entry into div.fcms-items, inserting values as text", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-href="/ignored/{slug}"><template>
    <article class="card"><h3 data-field="title"></h3><span class="price" data-field="price"></span></article>
  </template></div>`;
  mockItems([entry({ data: { title: "<b>x</b>", price: 580 } }), entry({ id: "e_000000000002", data: { title: "B", price: 0 } })]);
  load();
  await win.femtocms.refresh();
  expect(q("ul.fcms-list")).toBeNull();
  const cards = qa("div.fcms-items > article.card");
  expect(cards.length).toBe(2);
  expect(cards[0].querySelector("h3").textContent).toBe("<b>x</b>");
  expect(cards[0].querySelector("h3").innerHTML).not.toContain("<b>");
  expect(cards[1].querySelector(".price").textContent).toBe("0");
  expect(q("a")).toBeNull();
  expect(q("template")).toBeNull();
});

it("template: wraps in ul.fcms-items when the content is <li>", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template><li data-field="title"></li></template></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  expect(q("ul.fcms-items > li").textContent).toBe("Hello");
});

it("template: img gets src, alt, width/height and lazy; an img with no value or a dangerous URL is removed", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c"><img class="thumb" data-field="cover"><img class="keep" data-field="cover" alt="固定" loading="eager"></div>
  </template></div>`;
  mockItems([
    entry({ data: { title: "A", cover: { url: "https://cms.test/media/m_1/a.png", alt: "ラテ", width: 800, height: 600 } } }),
    entry({ id: "e_000000000002", data: { title: "B" } }),
    entry({ id: "e_000000000003", data: { title: "C", cover: { url: "javascript:alert(1)", alt: "" } } }),
  ]);
  load();
  await win.femtocms.refresh();
  const cards = qa(".c");
  const img = cards[0].querySelector("img.thumb");
  expect(img.getAttribute("src")).toBe("https://cms.test/media/m_1/a.png");
  expect(img.getAttribute("alt")).toBe("ラテ");
  expect(img.getAttribute("width")).toBe("800");
  expect(img.getAttribute("height")).toBe("600");
  expect(img.getAttribute("loading")).toBe("lazy");
  const keep = cards[0].querySelector("img.keep");
  expect(keep.getAttribute("alt")).toBe("固定");
  expect(keep.getAttribute("loading")).toBe("eager");
  expect(cards[1].querySelector("img")).toBeNull();
  expect(cards[2].querySelector("img")).toBeNull();
});

it("template: <time> gets a datetime attribute and a readable date (also for datetimes inside data)", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-locale="en-US"><template>
    <p><time class="pub" data-field="publishedAt"></time><time class="ev" data-field="eventAt"></time><span class="raw" data-field="publishedAt"></span></p>
  </template></div>`;
  mockItems([entry({ data: { title: "A", eventAt: "2026-12-24T09:00:00.000Z" } })]);
  load();
  await win.femtocms.refresh();
  expect(q("time.pub").getAttribute("datetime")).toBe("2026-11-26T00:00:00.000Z");
  expect(q("time.pub").textContent).toBe(new Date("2026-11-26T00:00:00.000Z").toLocaleDateString("en-US"));
  expect(q("time.ev").getAttribute("datetime")).toBe("2026-12-24T09:00:00.000Z");
  expect(q("time.ev").textContent).toBe(new Date("2026-12-24T09:00:00.000Z").toLocaleDateString("en-US"));
  expect(q(".raw").textContent).toBe("2026-11-26T00:00:00.000Z");
});

it("template: Markdown fields get HTML converted by the server, and multi-selects are joined with \", \"", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c"><div class="body" data-field="body"></div><span class="tags" data-field="tags"></span><span class="obj" data-field="meta"></span><span class="flag" data-field="soldOut">x</span></div>
  </template></div>`;
  mockItems([entry({ data: { title: "A", body: "**md**", tags: ["menu", "event"], meta: { a: 1 }, soldOut: true }, html: { body: "<p><strong>md</strong></p>" } })]);
  load();
  await win.femtocms.refresh();
  expect(q(".body").innerHTML).toBe("<p><strong>md</strong></p>");
  expect(q(".tags").textContent).toBe("menu, event");
  expect(q(".obj").textContent).toBe("");
  expect(q(".flag").textContent).toBe("");
});

it("template: data-if removes the element for empty, false, null and []; 0 is kept; ! inverts", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c"><b class="sold" data-if="soldOut">売り切れ</b><b class="open" data-if="!soldOut">販売中</b>
    <i class="price" data-if="price">p</i><i class="note" data-if="note">n</i><i class="tags" data-if="tags">t</i></div>
  </template></div>`;
  mockItems([
    entry({ data: { title: "A", soldOut: true, price: 0, note: "", tags: [] } }),
    entry({ id: "e_000000000002", data: { title: "B", soldOut: false, note: "あり", tags: ["x"] } }),
  ]);
  load();
  await win.femtocms.refresh();
  const [a, b] = qa(".c");
  expect(a.querySelector(".sold")).not.toBeNull();
  expect(a.querySelector(".open")).toBeNull();
  expect(a.querySelector(".price")).not.toBeNull();
  expect(a.querySelector(".note")).toBeNull();
  expect(a.querySelector(".tags")).toBeNull();
  expect(b.querySelector(".sold")).toBeNull();
  expect(b.querySelector(".open")).not.toBeNull();
  expect(b.querySelector(".price")).toBeNull();
  expect(b.querySelector(".note")).not.toBeNull();
  expect(b.querySelector(".tags")).not.toBeNull();
});

it("template: data-class adds \"field-value\", adds the field name when true, and strips symbols", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c" data-class="category soldOut tags weird"></div>
  </template></div>`;
  mockItems([entry({ data: { title: "A", category: "menu", soldOut: true, tags: ["a", "b c"], weird: "x\"><y" } })]);
  load();
  await win.femtocms.refresh();
  const cls = [...q(".c").classList];
  expect(cls).toEqual(expect.arrayContaining(["c", "category-menu", "soldOut", "tags-a", "tags-bc", "weird-xy"]));
  expect(cls.length).toBe(6);
});

it("template: data-href substitutes URL-encoded {field} values and does not attach dangerous links", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c"><a class="ok" data-href="news.html?slug={slug}&c={category}&id={id}">x</a><a class="bad" data-href="javascript:{slug}">y</a></div>
  </template></div>`;
  mockItems([entry({ slug: "a/b", data: { title: "A", category: "お知らせ" } }), entry({ id: "e_000000000002", slug: null, data: { title: "B" } })]);
  load();
  await win.femtocms.refresh();
  const [a, b] = qa(".c");
  expect(a.querySelector(".ok").getAttribute("href")).toBe(`news.html?slug=a%2Fb&c=${encodeURIComponent("お知らせ")}&id=e_abc123def456`);
  expect(a.querySelector(".bad").hasAttribute("href")).toBe(false);
  expect(b.querySelector(".ok").getAttribute("href")).toBe("news.html?slug=e_000000000002&c=&id=e_000000000002");
});

it("template: data-each repeats a list field, can be nested, and reads each item's fields inside", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms-entry="pricing" data-slug="pricing"><template>
    <section><h2 data-field="title"></h2>
      <template data-each="plans"><div class="plan"><h3 data-field="name"></h3>
        <ul><template data-each="features"><li data-field="label"></li></template></ul></div></template>
    </section>
  </template></div>`;
  mockEntry(entry({ slug: "pricing", data: { title: "料金", plans: [
    { name: "ライト", features: [{ label: "A" }, { label: "B" }] },
    { name: "プロ", features: [{ label: "C" }], title: "内側" },
  ] } }));
  load();
  await win.femtocms.refresh();
  expect(q("h2").textContent).toBe("料金");
  const plans = qa(".plan");
  expect(plans.map((p) => p.querySelector("h3").textContent)).toEqual(["ライト", "プロ"]);
  expect([...plans[0].querySelectorAll("li")].map((l: any) => l.textContent)).toEqual(["A", "B"]);
  expect([...plans[1].querySelectorAll("li")].map((l: any) => l.textContent)).toEqual(["C"]);
  expect(q("template")).toBeNull();
});

it("template: inside data-each, data-field=\".\" is the item itself (a gallery of multiple images)", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms-entry="shop" data-slug="s"><template>
    <div class="g"><template data-each="photos"><img data-field="."></template></div>
  </template></div>`;
  mockEntry(entry({ data: { title: "S", photos: [{ url: "https://cms.test/media/m_1/a.png", alt: "1" }, { url: "https://cms.test/media/m_2/b.png", alt: "2" }] } }));
  load();
  await win.femtocms.refresh();
  expect(qa(".g img").map((i) => i.getAttribute("src"))).toEqual(["https://cms.test/media/m_1/a.png", "https://cms.test/media/m_2/b.png"]);
});

it("template: when it finds something like author.name, adds expand automatically and renders the expanded entry's content", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c"><span class="who" data-field="author.name"></span><img data-field="author.photo">
      <template data-each="related"><a class="rel" data-href="?slug={slug}" data-field="title"></a></template></div>
  </template></div>`;
  const fetchMock = mockItems([entry({ data: {
    title: "A",
    author: { id: "e_000000000009", slug: "yamada", data: { name: "山田", photo: { url: "https://cms.test/media/m_9/y.png", alt: "山田" } }, html: {} },
    related: [{ id: "e_000000000007", slug: "r1", data: { title: "関連1" }, html: {} }],
  } })]);
  load();
  await win.femtocms.refresh();
  const u = new URL(String((fetchMock.mock.calls.at(-1) as unknown[])[0]));
  expect(u.searchParams.get("expand")).toBe("author,related");
  expect(q(".who").textContent).toBe("山田");
  expect(q(".c img").getAttribute("src")).toBe("https://cms.test/media/m_9/y.png");
  expect(q(".rel").textContent).toBe("関連1");
  expect(q(".rel").getAttribute("href")).toBe("?slug=r1");
});

it("template: a reference that could not be expanded (left as an ID) is emptied and warns on the console", async () => {
  setPageUrl("https://lp.test/");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = `<div data-femtocms="news"><template><span class="who" data-field="author.name">?</span></template></div>`;
  mockItems([entry({ data: { title: "A", author: "e_000000000009" } })]);
  load();
  await win.femtocms.refresh();
  expect(q(".who").textContent).toBe("");
  expect(warn).toHaveBeenCalled();
});

it("template: a field name that is a prototype property name renders nothing", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template><span class="p" data-field="constructor"></span><span class="q" data-field="title.length"></span></template></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  expect(q(".p").textContent).toBe("");
  expect(q(".q").textContent).toBe("");
});

it("template: remembers the template across refresh and renders in the same shape", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template><p class="t" data-field="title"></p></template></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  await win.femtocms.refresh();
  expect(qa("p.t").length).toBe(1);
  expect(q("ul.fcms-list")).toBeNull();
});

it("template: load more appends with the same template and also passes expand", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="more"><template><p class="t"><span data-field="title"></span><span data-field="author.name"></span></p></template></div>`;
  const fetchMock = mockPaged(5);
  load();
  await win.femtocms.refresh();
  await win.femtocms.more(q("[data-femtocms]"));
  expect(qa("div.fcms-items > p.t").map((p) => p.textContent)).toEqual(["T0", "T1", "T2", "T3"]);
  const u = new URL(String((fetchMock.mock.calls.at(-1) as unknown[])[0]));
  expect(u.searchParams.get("offset")).toBe("2");
  expect(u.searchParams.get("expand")).toBe("author");
});

it("template: works on an entry page too, passes expand and preview, and can change the tab title", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte&preview=tok");
  document.title = "Cafe";
  document.body.innerHTML = `<div data-femtocms-entry="news" data-document-title><template>
    <article class="post"><h1 data-field="title"></h1><div class="b" data-field="body"></div><span data-field="author.name"></span></article>
  </template></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  const u = new URL(String((fetchMock.mock.calls.at(-1) as unknown[])[0]));
  expect(u.pathname).toBe("/api/news/winter-latte");
  expect(u.searchParams.get("preview")).toBe("tok");
  expect(u.searchParams.get("expand")).toBe("author");
  expect(q("article.post h1").textContent).toBe("<i>冬</i>のラテ");
  expect(q("article.post .b").innerHTML).toBe("<p><strong>md</strong></p>");
  expect(q("article.fcms-entry")).toBeNull();
  expect(document.title).toBe("<i>冬</i>のラテ | Cafe");
});

it("template: shows data-empty when the entry is not found", async () => {
  setPageUrl("https://lp.test/news.html?slug=nope");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-empty="ありません"><template><h1 data-field="title"></h1></template></div>`;
  mockEntry({ error: { code: "not_found" } }, 404);
  load();
  await win.femtocms.refresh();
  expect(q(".fcms-empty").textContent).toBe("ありません");
});

it("template: works with page numbers too, and the nav comes after .fcms-items", async () => {
  setPageUrl("https://lp.test/list.html?page=2");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="pages"><template><p class="t" data-field="title"></p></template></div>`;
  mockPaged(5);
  load();
  await win.femtocms.refresh();
  const root = q("[data-femtocms]");
  expect([...root.children].map((c: any) => c.className)).toEqual(["fcms-items", "fcms-pager"]);
  expect(qa("p.t").map((p) => p.textContent)).toEqual(["T2", "T3"]);
  expect(q(".fcms-pager-current").textContent).toBe("2");
});

// ---- Pager template: <template data-pager> ----

const PAGES_TPL = `<template data-pager>
  <nav class="my">
    <a class="first" data-page="first">«</a><a class="prev" data-page="prev">‹</a>
    <template data-each="pages"><span class="gap" data-if="gap">…</span><a class="num" data-if="!gap" data-page data-field="number" data-class="current"></a></template>
    <a class="next" data-page="next">›</a><a class="last" data-page="last">»</a>
    <span class="info"><span class="cur" data-field="current"></span>/<span class="tp" data-field="totalPages"></span>（<span class="tot" data-field="total"></span>件）</span>
    <b class="hp" data-if="hasPrev">p</b><b class="hn" data-if="hasNext">n</b>
  </nav>
</template>`;

it("pager template: renders page numbers with your own HTML, and links keep the other URL parameters", async () => {
  setPageUrl("https://lp.test/list.html?page=2&x=1");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="pages"><template><p class="t" data-field="title"></p></template>${PAGES_TPL}</div>`;
  mockPaged(9);
  load();
  await win.femtocms.refresh();
  const root = q("[data-femtocms]");
  expect([...root.children].map((c: any) => c.className)).toEqual(["fcms-items", "fcms-pager-custom"]);
  expect(q(".fcms-pager")).toBeNull();
  expect(qa("p.t").map((p) => p.textContent)).toEqual(["T2", "T3"]);
  expect(q(".prev").getAttribute("href")).toBe("?page=1&x=1");
  expect(q(".next").getAttribute("href")).toBe("?page=3&x=1");
  expect(q(".first").getAttribute("href")).toBe("?page=1&x=1");
  expect(q(".last").getAttribute("href")).toBe("?page=5&x=1");
  const nums = qa("a.num");
  expect(nums.map((a) => a.textContent)).toEqual(["1", "2", "3", "4", "5"]);
  expect(nums.map((a) => a.getAttribute("href"))).toEqual(["?page=1&x=1", "?page=2&x=1", "?page=3&x=1", "?page=4&x=1", "?page=5&x=1"]);
  expect(nums[1].classList.contains("current")).toBe(true);
  expect(nums[1].getAttribute("aria-current")).toBe("page");
  expect(nums[0].classList.contains("current")).toBe(false);
  expect(nums[0].hasAttribute("aria-current")).toBe(false);
  expect(q(".info").textContent).toBe("2/5（9件）");
  expect(q(".hp")).not.toBeNull();
  expect(q(".hn")).not.toBeNull();
  expect(q(".gap")).toBeNull();
  expect(q("template")).toBeNull();
});

it("pager template: removes the link and adds aria-disabled when there is no prev/next, and shows … when there are many pages", async () => {
  setPageUrl("https://lp.test/list.html");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="pages" data-page-param="p">${PAGES_TPL}</div>`;
  mockPaged(40);
  load();
  await win.femtocms.refresh();
  expect(q("ul.fcms-list")).not.toBeNull();
  expect(q(".prev").hasAttribute("href")).toBe(false);
  expect(q(".prev").getAttribute("aria-disabled")).toBe("true");
  expect(q(".next").getAttribute("href")).toBe("?p=2");
  expect(q(".next").hasAttribute("aria-disabled")).toBe(false);
  expect(q(".hp")).toBeNull();
  expect(qa("a.num").map((a) => a.textContent)).toEqual(["1", "2", "20"]);
  expect(qa(".gap").length).toBe(1);

  setPageUrl("https://lp.test/list.html?p=20");
  await win.femtocms.refresh();
  expect(q(".next").hasAttribute("href")).toBe(false);
  expect(q(".next").getAttribute("aria-disabled")).toBe("true");
  expect(q(".hn")).toBeNull();
  expect(qa(".fcms-pager-custom").length).toBe(1);
});

it("pager template: not rendered when everything fits on one page", async () => {
  setPageUrl("https://lp.test/list.html");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="5" data-pager="pages">${PAGES_TPL}</div>`;
  mockPaged(3);
  load();
  await win.femtocms.refresh();
  expect(q(".fcms-pager-custom")).toBeNull();
  expect(q("nav")).toBeNull();
});

it("pager template: a data-more button appends, updates the remaining count, cannot be pressed while loading, and disappears when all are shown", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="more">
    <template><p class="t" data-field="title"></p></template>
    <template data-pager><div class="box"><button class="mine" data-more>残り<span class="rem" data-field="remaining"></span>件（<span class="ld" data-field="loaded"></span>/<span class="tt" data-field="total"></span>）</button></div></template>
  </div>`;
  mockPaged(5);
  load();
  await win.femtocms.refresh();
  expect(q(".fcms-more")).toBeNull();
  expect(q("button.mine").textContent).toBe("残り3件（2/5）");
  q("button.mine").click();
  expect(q("button.mine").hasAttribute("disabled")).toBe(true);
  await vi.waitFor(() => expect(qa("p.t").length).toBe(4));
  expect(q("button.mine").hasAttribute("disabled")).toBe(false);
  expect(q("button.mine").textContent).toBe("残り1件（4/5）");
  expect(qa(".fcms-pager-custom").length).toBe(1);
  q("button.mine").click();
  await vi.waitFor(() => expect(qa("p.t").length).toBe(5));
  expect(q(".fcms-pager-custom")).toBeNull();
  expect(q("button.mine")).toBeNull();
});

it("pager template: a data-more link appends without navigating to another page", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="more"><template data-pager><a class="m" href="#more" data-more>more</a></template></div>`;
  mockPaged(3);
  load();
  await win.femtocms.refresh();
  const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  q("a.m").dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(qa(".fcms-title").length).toBe(3));
});


// ---- Prev/next, empty, error, sort order, single ----

function mockRouter(route: (u: URL) => unknown) {
  const fn = vi.fn(async (url: string) => {
    const r = route(new URL(String(url)));
    return r instanceof Response ? r : Response.json(r);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const PUB = "2026-11-20T00:00:00.000Z";
const older = entry({ id: "e_000000000001", slug: "older", publishedAt: "2026-11-10T00:00:00.000Z", data: { title: "古い記事" } });
const newer = entry({ id: "e_000000000003", slug: "newer", publishedAt: "2026-11-25T00:00:00.000Z", data: { title: "新しい記事" } });
const middle = entry({ id: "e_000000000002", slug: "middle", publishedAt: PUB, data: { title: "真ん中", category: "menu" } });
function neighbors(opts: { older?: unknown; newer?: unknown; current?: unknown } = {}) {
  return mockRouter((u) => {
    if (u.pathname === "/api/news/middle") return opts.current ?? middle;
    if (u.searchParams.get("after")) return { items: opts.older === null ? [] : [opts.older ?? older], total: 1 };
    if (u.searchParams.get("before")) return { items: opts.newer === null ? [] : [opts.newer ?? newer], total: 1 };
    return new Response("?", { status: 500 });
  });
}

it("prev/next: data-prevnext renders links to the entry published just before (older) and just after (newer)", async () => {
  setPageUrl("https://lp.test/news.html?slug=middle&x=1&preview=tok");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-prevnext></div>`;
  const fetchMock = neighbors({ current: { ...middle } });
  load();
  await win.femtocms.refresh();
  const urls = fetchMock.mock.calls.map((c) => new URL(String((c as unknown[])[0])));
  // prev = the next row of the list (newest first), next = the previous row: the server's after / before cursors.
  const o = urls.find((u) => u.searchParams.has("after"))!;
  const n = urls.find((u) => u.searchParams.has("before"))!;
  expect(o.pathname).toBe("/api/news");
  expect(o.searchParams.get("after")).toBe("e_000000000002");
  expect(o.searchParams.get("sort")).toBe("-publishedAt");
  expect(o.searchParams.get("limit")).toBe("1");
  expect(n.searchParams.get("before")).toBe("e_000000000002");
  expect(n.searchParams.get("sort")).toBe("-publishedAt");
  expect(urls.some((u) => [...u.searchParams.keys()].some((k) => k.startsWith("filter[publishedAt]")))).toBe(false);
  const nav = q("[data-femtocms-entry] > nav.fcms-prevnext");
  expect(q("[data-femtocms-entry] > article.fcms-entry")).not.toBeNull();
  const prev = nav.querySelector("a.fcms-prev");
  const next = nav.querySelector("a.fcms-next");
  expect(prev.getAttribute("href")).toBe("?slug=older&x=1");
  expect(prev.getAttribute("rel")).toBe("prev");
  expect(prev.textContent).toContain("古い記事");
  expect(next.getAttribute("href")).toBe("?slug=newer&x=1");
  expect(next.getAttribute("rel")).toBe("next");
  expect(next.textContent).toContain("新しい記事");
});

it("prev/next: only one side if only one exists, nothing if neither exists; does not look for neighbors on a draft", async () => {
  setPageUrl("https://lp.test/news.html?slug=middle");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-prevnext></div>`;
  neighbors({ newer: null });
  load();
  await win.femtocms.refresh();
  expect(q("a.fcms-prev")).not.toBeNull();
  expect(q("a.fcms-next")).toBeNull();

  neighbors({ newer: null, older: null });
  await win.femtocms.refresh();
  expect(q("nav.fcms-prevnext")).toBeNull();

  const fetchMock = neighbors({ current: { ...middle, status: "draft", publishedAt: null } });
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(q("nav.fcms-prevnext")).toBeNull();
});

it("prev/next: with data-href the links take that shape, and data-filter narrows the search range", async () => {
  setPageUrl("https://lp.test/news.html?slug=middle");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-prevnext data-href="/news/{slug}" data-filter="category=menu"></div>`;
  const fetchMock = neighbors();
  load();
  await win.femtocms.refresh();
  expect(q("a.fcms-prev").getAttribute("href")).toBe("/news/older");
  expect(q("a.fcms-next").getAttribute("href")).toBe("/news/newer");
  const lt = fetchMock.mock.calls.map((c) => new URL(String((c as unknown[])[0]))).find((u) => u.searchParams.has("after"))!;
  expect(lt.searchParams.get("filter[category]")).toBe("menu");
});

it("prev/next: <template data-prevnext> allows your own HTML, data-page makes the link, and prev / next read the content", async () => {
  setPageUrl("https://lp.test/news.html?slug=middle");
  document.body.innerHTML = `<div data-femtocms-entry="news">
    <template><h1 data-field="title"></h1></template>
    <template data-prevnext><nav class="pn">
      <a class="p" data-page="prev" data-if="prev">← <span data-field="prev.title"></span></a>
      <a class="n" data-page="next">→ <span data-field="next.title"></span></a>
    </nav></template>
  </div>`;
  neighbors({ newer: null });
  load();
  await win.femtocms.refresh();
  expect(q("h1").textContent).toBe("真ん中");
  const wrap = q("[data-femtocms-entry] > .fcms-prevnext-custom");
  expect(wrap.querySelector("a.p").getAttribute("href")).toBe("?slug=older");
  expect(wrap.querySelector("a.p span").textContent).toBe("古い記事");
  expect(wrap.querySelector("a.n").hasAttribute("href")).toBe(false);
  expect(wrap.querySelector("a.n").getAttribute("aria-disabled")).toBe("true");
  expect(q("nav.fcms-prevnext")).toBeNull();
  expect(q("template")).toBeNull();
});

it("empty template: <template data-empty> is shown for 0 entries or when not found", async () => {
  setPageUrl("https://lp.test/news.html?slug=nope");
  document.body.innerHTML = `
    <div id="l" data-femtocms="news" data-empty="使われない"><template><p data-field="title"></p></template><template data-empty><p class="none">まだありません <a href="/">トップへ</a></p></template></div>
    <div id="e" data-femtocms-entry="news"><template data-empty><p class="nf">見つかりません</p></template></div>`;
  mockRouter((u) => (u.pathname === "/api/news" ? { items: [], total: 0 } : new Response("{}", { status: 404 })));
  load();
  await win.femtocms.refresh();
  expect(q("#l .none").textContent).toBe("まだありません トップへ");
  expect(q("#l .fcms-empty")).toBeNull();
  expect(q("#e .nf").textContent).toBe("見つかりません");
  expect(q("template")).toBeNull();
});

it("error template: <template data-error> is shown when loading fails; a loading indicator written inside is removed on render", async () => {
  setPageUrl("https://lp.test/news.html?slug=a");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = `
    <div id="l" data-femtocms="news"><p class="loading">読み込み中…</p><template data-error><p class="err">読み込めませんでした</p></template></div>
    <div id="e" data-femtocms-entry="news"><template data-error><p class="err">読み込めませんでした</p></template></div>
    <div id="ok" data-femtocms="ok"><p class="loading">読み込み中…</p></div>`;
  mockRouter((u) => (u.pathname === "/api/ok" ? { items: [entry()], total: 1 } : new Response("x", { status: 500 })));
  load();
  await win.femtocms.refresh();
  expect(q("#l .err").textContent).toBe("読み込めませんでした");
  expect(q("#l .loading")).toBeNull();
  expect(q("#e .err").textContent).toBe("読み込めませんでした");
  expect(q("#ok .loading")).toBeNull();
  expect(q("#ok .fcms-title").textContent).toBe("Hello");
});

it("data-sort changes the order, and load more reads in the same order; an invalid format falls back to the default and warns", async () => {
  setPageUrl("https://lp.test/");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = `
    <div id="a" data-femtocms="menu" data-sort="order,-price" data-limit="2" data-pager="more"></div>
    <div id="b" data-femtocms="news" data-sort="title; drop"></div>`;
  const fetchMock = mockPaged(5);
  load();
  await win.femtocms.refresh();
  await win.femtocms.more(q("#a"));
  const urls = fetchMock.mock.calls.map((c) => new URL(String((c as unknown[])[0])));
  const menu = urls.filter((u) => u.pathname === "/api/menu");
  expect(menu.every((u) => u.searchParams.get("sort") === "order,-price")).toBe(true);
  expect(menu.at(-1)!.searchParams.get("offset")).toBe("2");
  expect(urls.find((u) => u.pathname === "/api/news")!.searchParams.get("sort")).toBe("-publishedAt");
  expect(warn).toHaveBeenCalled();
});

it("single collection: without a slug, shows the collection's one entry", async () => {
  setPageUrl("https://lp.test/about.html");
  document.body.innerHTML = `<div data-femtocms-entry="about"><template><h1 data-field="title"></h1><span data-field="owner.name"></span></template></div>`;
  const fetchMock = mockRouter(() => entry({ slug: null, data: { title: "会社概要" } }));
  load();
  await win.femtocms.refresh();
  const u = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
  expect(u.pathname).toBe("/api/about");
  expect(u.searchParams.get("expand")).toBe("owner");
  expect(q("h1").textContent).toBe("会社概要");
});

it("the role of a template is decided by its attributes, regardless of order", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="1" data-pager="more">
    <template data-error><p class="err">e</p></template>
    <template data-pager><button class="m" data-more>more</button></template>
    <template data-empty><p class="none">none</p></template>
    <template><p class="t" data-field="title"></p></template>
  </div>`;
  mockPaged(3);
  load();
  await win.femtocms.refresh();
  expect(qa("p.t").map((p) => p.textContent)).toEqual(["T0"]);
  expect(q("button.m")).not.toBeNull();
  expect(q(".err")).toBeNull();
  expect(q(".none")).toBeNull();
});

// ---- Review findings ----

it("safety: even if json fields or lists contain entry-shaped data, html is not inserted as HTML", async () => {
  setPageUrl("https://lp.test/");
  const forged = { data: { x: "a" }, html: { x: "<img src=x onerror=alert(1)>" } };
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c"><span class="m" data-field="meta.x"></span><template data-each="rows"><span class="r" data-field="x"></span></template>
    <span class="a" data-field="author.body"></span><div class="own" data-field="body"></div></div>
  </template></div>`;
  mockItems([entry({
    data: { title: "A", body: "**b**", meta: forged, rows: [forged], author: { id: "e_000000000009", data: { body: "**x**" }, html: { body: "<b>x</b>" } } },
    html: { body: "<p><strong>b</strong></p>" },
  })]);
  load();
  await win.femtocms.refresh();
  expect(q(".m").textContent).toBe("a");
  expect(q(".m").innerHTML).not.toContain("<img");
  expect(q(".r").textContent).toBe("a");
  expect(q(".a").textContent).toBe("**x**");
  expect(q(".own").innerHTML).toBe("<p><strong>b</strong></p>");
  expect(document.querySelectorAll("img").length).toBe(0);
});

it("safety: Markdown of prev/next entries (returned by the API) is inserted as HTML", async () => {
  setPageUrl("https://lp.test/news.html?slug=middle");
  document.body.innerHTML = `<div data-femtocms-entry="news"><template><h1 data-field="title"></h1></template>
    <template data-prevnext><div class="pb" data-field="prev.body"></div></template></div>`;
  neighbors({ newer: null, older: { ...older, data: { title: "古い記事", body: "**o**" }, html: { body: "<p><strong>o</strong></p>" } } });
  load();
  await win.femtocms.refresh();
  expect(q(".pb").innerHTML).toBe("<p><strong>o</strong></p>");
});

it("data-document-title: titles do not pile up on re-render, and the original is restored when not found", async () => {
  setPageUrl("https://lp.test/news.html?slug=a");
  document.title = "Cafe";
  document.body.innerHTML = `<div data-femtocms-entry="news" data-document-title></div>`;
  mockRouter((u) => (u.pathname === "/api/news/a" ? entry({ data: { title: "A" } }) : u.pathname === "/api/news/b" ? entry({ data: { title: "B" } }) : new Response("{}", { status: 404 })));
  load();
  await win.femtocms.refresh();
  await win.femtocms.refresh();
  expect(document.title).toBe("A | Cafe");
  setPageUrl("https://lp.test/news.html?slug=b");
  await win.femtocms.refresh();
  expect(document.title).toBe("B | Cafe");
  setPageUrl("https://lp.test/news.html?slug=none");
  await win.femtocms.refresh();
  expect(document.title).toBe("Cafe");
});

it("pager template: on a page beyond the page count, prev points at the last page (same as the default)", async () => {
  setPageUrl("https://lp.test/list.html?page=9");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="pages">${PAGES_TPL}</div>`;
  mockPaged(5);
  load();
  await win.femtocms.refresh();
  expect(q(".prev").getAttribute("href")).toBe("?page=3");
  expect(q(".next").hasAttribute("href")).toBe(false);
});


it("safety: for references the server listed in expanded, their Markdown is inserted as HTML (also inside data-each)", async () => {
  setPageUrl("https://lp.test/");
  const forged = { data: { x: "a" }, html: { x: "<img src=x onerror=alert(1)>" } };
  document.body.innerHTML = `<div data-femtocms="news"><template>
    <div class="c"><div class="a" data-field="author.body"></div><span class="m" data-field="meta.x"></span>
    <template data-each="related"><div class="r" data-field="body"></div></template></div>
  </template></div>`;
  mockItems([entry({
    expanded: ["author", "related"],
    data: {
      title: "A", meta: forged,
      author: { id: "e_000000000009", data: { body: "**x**" }, html: { body: "<p><strong>x</strong></p>" } },
      related: [{ id: "e_000000000008", data: { body: "**y**" }, html: { body: "<p><strong>y</strong></p>" } }],
    },
  })]);
  load();
  await win.femtocms.refresh();
  expect(q(".a").innerHTML).toBe("<p><strong>x</strong></p>");
  expect(q(".r").innerHTML).toBe("<p><strong>y</strong></p>");
  expect(q(".m").textContent).toBe("a");
  expect(document.querySelectorAll("img").length).toBe(0);
});


it("the minified build (the deployed embed.js) renders the same way", async () => {
  // @ts-expect-error -- plain .mjs build helper without type declarations
  const { minifyEmbed } = await import("../../scripts/minify-embed.mjs");
  const min = minifyEmbed(script) as string;
  setPageUrl("https://lp.test/list.html?page=2");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="2" data-pager="pages">
    <template><p class="t" data-field="title" data-class="status"></p></template>${PAGES_TPL}</div>`;
  mockPaged(5);
  new Function(min)();
  await win.femtocms.refresh();
  expect(qa("p.t").map((p) => p.textContent)).toEqual(["T2", "T3"]);
  expect(q("p.t").classList.contains("status-published")).toBe(true);
  expect(q(".next").getAttribute("href")).toBe("?page=3");
});
