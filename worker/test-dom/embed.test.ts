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
