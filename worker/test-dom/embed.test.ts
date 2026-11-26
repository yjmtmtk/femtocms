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

it("一覧を描画し、タイトルの HTML は文字として出る", async () => {
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

it("limit は 1〜100 に丸め、既定は 5。コレクション名は URL エンコードする", async () => {
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

it("data-fields: 文字列・数値は span、日付は time、画像は明示時のみ http(s) だけ img", async () => {
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

it("既定ではデータ内の画像や任意フィールドは出さない", async () => {
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  mockItems([entry({ data: { title: "T", cover: { url: "https://cms.test/media/m_1" }, body: "secret" } })]);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector(".fcms-field-body")).toBeNull();
});

it("data-locale で日付の表示言語を変える", async () => {
  document.body.innerHTML = `<div data-femtocms="news" data-locale="en-US"></div>`;
  mockItems([entry({ publishedAt: "2026-11-26T12:00:00.000Z" })]);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("time.fcms-date")!.textContent).toBe(new Date("2026-11-26T12:00:00.000Z").toLocaleDateString("en-US"));
});

it("data-href: {id} も置換し、slug が無ければ id を使い、値は URL エンコードする", async () => {
  document.body.innerHTML = `<div data-femtocms="news" data-href="/n/{slug}?id={id}"></div>`;
  mockItems([entry({ slug: null, id: "e_x y" }), entry({ slug: "a/b" })]);
  load();
  await win.femtocms.refresh();
  const hrefs = [...document.querySelectorAll("a.fcms-link")].map((a) => a.getAttribute("href"));
  expect(hrefs).toEqual(["/n/e_x%20y?id=e_x%20y", "/n/a%2Fb?id=e_abc123def456"]);
});

it("data-href が危険なスキームならリンクなしで描画する", async () => {
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

it("0件で data-empty を出す。指定が無ければ何も出さない", async () => {
  document.body.innerHTML = `<div id="a" data-femtocms="news" data-empty="お知らせはありません"></div><div id="b" data-femtocms="news"></div>`;
  mockItems([]);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("#a")!.textContent).toBe("お知らせはありません");
  expect(document.querySelector("#a ul")).toBeNull();
  expect(document.querySelector("#b")!.innerHTML).toBe("");
});

it("取得失敗でも例外を投げず、要素は空のまま console.warn する", async () => {
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  globalThis.fetch = vi.fn(async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  load();
  await expect(win.femtocms.refresh()).resolves.toBeUndefined();
  expect(document.querySelector("[data-femtocms]")!.innerHTML).toBe("");
  expect(warn).toHaveBeenCalledWith("[femtocms]", expect.anything());
});

it("HTTP エラーや想定外の本文でも例外を投げず空のまま", async () => {
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

it("style は1回だけ入り、セレクタはすべて :where で詳細度 0", async () => {
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

it("refresh を重ねて呼んでも一覧は重複しない", async () => {
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  mockItems([entry(), entry({ id: "e_2", slug: "b" })]);
  load();
  await Promise.all([win.femtocms.refresh(), win.femtocms.refresh()]);
  await win.femtocms.refresh();
  expect(document.querySelectorAll("li.fcms-item").length).toBe(2);
  expect(document.querySelectorAll("ul.fcms-list").length).toBe(1);
});

it("後から追加した要素も refresh で描画される", async () => {
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  await win.femtocms.refresh();
  expect(document.querySelectorAll("li.fcms-item").length).toBe(1);
});

it("グローバルに増えるのは window.femtocms だけ", async () => {
  const before = new Set(Object.getOwnPropertyNames(win));
  load();
  const added = Object.getOwnPropertyNames(win).filter((k) => !before.has(k));
  expect(added).toEqual(["femtocms"]);
});

it("ベース URL が決まらなければ警告だけ出して何もしない", async () => {
  delete win.FEMTOCMS_BASE;
  document.body.innerHTML = `<div data-femtocms="news"></div>`;
  const fetchMock = mockItems([entry()]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  load();
  await win.femtocms.refresh();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalled();
});

// ---- 詳細表示: [data-femtocms-entry] ----

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

it("詳細: URL の ?slug= の記事を取得し、タイトル・日付・本文 HTML を article に描画する", async () => {
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
  // 既定では画像などは出さない
  expect(article.querySelector("img")).toBeNull();
});

it("詳細: data-slug が URL より優先され、slug は URL エンコードされる", async () => {
  setPageUrl("https://lp.test/news.html?slug=ignored");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-slug="a b/c"></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news/a%20b%2Fc", { credentials: "omit" });
});

it("詳細: data-param で URL パラメータ名を変えられる", async () => {
  setPageUrl("https://lp.test/news.html?id=e_abc123def456");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-param="id"></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news/e_abc123def456", { credentials: "omit" });
});

it("詳細: ページ URL の preview トークンを API に渡す（下書きを LP のデザインで確認できる）", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte&preview=tok.en");
  document.body.innerHTML = `<div data-femtocms-entry="news"></div>`;
  const fetchMock = mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(fetchMock).toHaveBeenCalledWith("https://cms.test/api/news/winter-latte?preview=tok.en", { credentials: "omit" });
});

it("詳細: data-fields と data-heading で項目と見出しの要素を変えられる。画像は明示時のみ http(s)", async () => {
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

it("詳細: data-heading に見出し以外を指定されたら h1 にする", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-heading="script"></div>`;
  mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("script.fcms-title")).toBeNull();
  expect(document.querySelector("h1.fcms-title")).not.toBeNull();
});

it("詳細: 404 や slug 未指定では data-empty を出し、例外を投げない", async () => {
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
  const fetchMock = mockEntry(detail);
  await win.femtocms.refresh();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.querySelector("#b .fcms-empty")!.textContent).toBe("記事が見つかりません");
});

it("詳細: data-document-title を付けるとページのタイトルを記事タイトルにする", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.title = "Café";
  document.body.innerHTML = `<div data-femtocms-entry="news" data-document-title></div>`;
  mockEntry(detail);
  load();
  await win.femtocms.refresh();
  expect(document.title).toBe("<i>冬</i>のラテ | Café");
});

it("一覧と詳細が同じページにあっても両方描画する", async () => {
  setPageUrl("https://lp.test/news.html?slug=winter-latte");
  document.body.innerHTML = `<div data-femtocms="news"></div><div data-femtocms-entry="news"></div>`;
  globalThis.fetch = vi.fn(async (url: string) =>
    Response.json(String(url).includes("/api/news/") ? detail : { items: [entry()], total: 1 })) as unknown as typeof fetch;
  load();
  await win.femtocms.refresh();
  expect(document.querySelector("ul.fcms-list")).not.toBeNull();
  expect(document.querySelector("article.fcms-entry")).not.toBeNull();
});

// ---- ページ送りと絞り込み ----

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

it("data-filter を filter[...] に変換して API に渡す", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news" data-filter="category=menu&price[gte]=1000"></div>`;
  const fetchMock = mockItems([]);
  load();
  await win.femtocms.refresh();
  const u = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
  expect(u.searchParams.get("filter[category]")).toBe("menu");
  expect(u.searchParams.get("filter[price][gte]")).toBe("1000");
});

it("pages: URL の ?page= から offset を決め、ページ番号のナビを出す", async () => {
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
  expect(hrefs).toContain("?page=1&x=1"); // 前へ と 1
  expect(hrefs).toContain("?page=3&x=1"); // 次へ と 3
  expect(hrefs).toContain("?page=4&x=1");
  expect(nav.querySelector(".fcms-pager-prev")).not.toBeNull();
  expect(nav.querySelector(".fcms-pager-next")).not.toBeNull();
});

it("pages: 1ページ目は「前へ」なし、最後のページは「次へ」なし、1ページしかなければナビなし", async () => {
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

it("pages: ページ数が多いと前後だけ出して … で省略する。不正な page は 1 として扱う", async () => {
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

it("pages: data-page-param で URL パラメータ名を変えられ、範囲外のページは data-empty", async () => {
  setPageUrl("https://lp.test/list.html?p=9");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="3" data-pager="pages" data-page-param="p" data-empty="ありません"></div>`;
  mockPaged(5);
  load();
  await win.femtocms.refresh();
  expect(document.querySelector(".fcms-empty")!.textContent).toBe("ありません");
  const hrefs = [...document.querySelectorAll("nav.fcms-pager a")].map((a: any) => a.getAttribute("href"));
  expect(hrefs).toContain("?p=1");
});

it("more: 「もっと見る」で続きを追加し、全部読んだらボタンを消す", async () => {
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

it("more: ボタンのクリックで読み込み、data-more-label で文言を変えられる", async () => {
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

it("more: 全件が1ページに収まればボタンを出さない。取得失敗でもボタンは残り例外を投げない", async () => {
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

// ---- テンプレート: <template> で見た目を自由に決める ----

const q = (sel: string) => document.querySelector(sel) as any;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as any[];

it("テンプレート: 一覧を記事ごとに複製して div.fcms-items に入れ、値は文字として入れる", async () => {
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

it("テンプレート: 中身が <li> なら ul.fcms-items で包む", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template><li data-field="title"></li></template></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  expect(q("ul.fcms-items > li").textContent).toBe("Hello");
});

it("テンプレート: img には src・alt・幅高さ・lazy を入れ、値が無い・危険な URL の img は消す", async () => {
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

it("テンプレート: <time> には datetime 属性と読みやすい日付を入れる（data 内の日時も）", async () => {
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

it("テンプレート: Markdown 項目はサーバーで変換済みの HTML を入れ、複数選択は「, 」でつなぐ", async () => {
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

it("テンプレート: data-if は空・false・null・[] で要素ごと消し、0 は残す。! で反転する", async () => {
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

it("テンプレート: data-class は「項目名-値」を付け、true なら項目名、記号は取り除く", async () => {
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

it("テンプレート: data-href は {項目名} を URL エンコードして入れ、危険なリンクは付けない", async () => {
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

it("テンプレート: data-each で list 型を繰り返し、入れ子もでき、中では各要素の項目を読む", async () => {
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

it("テンプレート: data-each の中で data-field=\".\" は要素そのもの（複数画像のギャラリー）", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms-entry="shop" data-slug="s"><template>
    <div class="g"><template data-each="photos"><img data-field="."></template></div>
  </template></div>`;
  mockEntry(entry({ data: { title: "S", photos: [{ url: "https://cms.test/media/m_1/a.png", alt: "1" }, { url: "https://cms.test/media/m_2/b.png", alt: "2" }] } }));
  load();
  await win.femtocms.refresh();
  expect(qa(".g img").map((i) => i.getAttribute("src"))).toEqual(["https://cms.test/media/m_1/a.png", "https://cms.test/media/m_2/b.png"]);
});

it("テンプレート: author.name のような書き方を見つけたら expand を自動で付け、展開された記事の中身を出す", async () => {
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

it("テンプレート: 展開できなかった参照（ID のまま）は空にしてコンソールに警告する", async () => {
  setPageUrl("https://lp.test/");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = `<div data-femtocms="news"><template><span class="who" data-field="author.name">?</span></template></div>`;
  mockItems([entry({ data: { title: "A", author: "e_000000000009" } })]);
  load();
  await win.femtocms.refresh();
  expect(q(".who").textContent).toBe("");
  expect(warn).toHaveBeenCalled();
});

it("テンプレート: 項目名がプロトタイプの名前でも何も出さない", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template><span class="p" data-field="constructor"></span><span class="q" data-field="title.length"></span></template></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  expect(q(".p").textContent).toBe("");
  expect(q(".q").textContent).toBe("");
});

it("テンプレート: refresh し直してもテンプレートを覚えていて同じ形で描画する", async () => {
  setPageUrl("https://lp.test/");
  document.body.innerHTML = `<div data-femtocms="news"><template><p class="t" data-field="title"></p></template></div>`;
  mockItems([entry()]);
  load();
  await win.femtocms.refresh();
  await win.femtocms.refresh();
  expect(qa("p.t").length).toBe(1);
  expect(q("ul.fcms-list")).toBeNull();
});

it("テンプレート: もっと見るでも同じテンプレートで追加し、expand も渡す", async () => {
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

it("テンプレート: 記事ページでも使え、expand と preview を渡し、タブの題名も変えられる", async () => {
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

it("テンプレート: 記事が見つからなければ data-empty を出す", async () => {
  setPageUrl("https://lp.test/news.html?slug=nope");
  document.body.innerHTML = `<div data-femtocms-entry="news" data-empty="ありません"><template><h1 data-field="title"></h1></template></div>`;
  mockEntry({ error: { code: "not_found" } }, 404);
  load();
  await win.femtocms.refresh();
  expect(q(".fcms-empty").textContent).toBe("ありません");
});

it("テンプレート: ページ番号でも使え、ナビは .fcms-items のあとに出る", async () => {
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

// ---- ページ送りのテンプレート: <template data-pager> ----

const PAGES_TPL = `<template data-pager>
  <nav class="my">
    <a class="first" data-page="first">«</a><a class="prev" data-page="prev">‹</a>
    <template data-each="pages"><span class="gap" data-if="gap">…</span><a class="num" data-if="!gap" data-page data-field="number" data-class="current"></a></template>
    <a class="next" data-page="next">›</a><a class="last" data-page="last">»</a>
    <span class="info"><span class="cur" data-field="current"></span>/<span class="tp" data-field="totalPages"></span>（<span class="tot" data-field="total"></span>件）</span>
    <b class="hp" data-if="hasPrev">p</b><b class="hn" data-if="hasNext">n</b>
  </nav>
</template>`;

it("ページ送りテンプレート: ページ番号を自分の HTML で出し、リンク先はほかの URL パラメータを残す", async () => {
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

it("ページ送りテンプレート: 前後がなければリンクを外して aria-disabled を付け、多いときは … を出す", async () => {
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

it("ページ送りテンプレート: 1ページに収まるときは出さない", async () => {
  setPageUrl("https://lp.test/list.html");
  document.body.innerHTML = `<div data-femtocms="news" data-limit="5" data-pager="pages">${PAGES_TPL}</div>`;
  mockPaged(3);
  load();
  await win.femtocms.refresh();
  expect(q(".fcms-pager-custom")).toBeNull();
  expect(q("nav")).toBeNull();
});

it("ページ送りテンプレート: data-more のボタンで追加し、残り件数を更新し、読み込み中は押せず、全部出たら消える", async () => {
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

it("ページ送りテンプレート: data-more がリンクでもページ移動せずに追加する", async () => {
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
