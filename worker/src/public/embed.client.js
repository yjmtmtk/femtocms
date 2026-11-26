/* femtocms embed: renders a list into every [data-femtocms] element and one entry into every [data-femtocms-entry] element.
   A <template> child replaces the built-in markup (data-field / data-if / data-class / data-href / data-each). No dependencies. */
(function () {
  "use strict";
  if (window.femtocms) return;

  var script = document.currentScript;
  var DATE_FIELDS = { publishedAt: 1, createdAt: 1, updatedAt: 1 };
  var CSS = [
    ":where(.fcms-list){list-style:none;margin:0;padding:0}",
    ":where(.fcms-item){margin:0;padding:.5em 0}",
    ":where(.fcms-item,.fcms-link){display:flex;flex-wrap:wrap;align-items:baseline;gap:.25em 1em}",
    ":where(.fcms-link){color:inherit;text-decoration:none}",
    ":where(.fcms-link:hover .fcms-title){text-decoration:underline}",
    ":where(.fcms-date){opacity:.7;font-size:.9em}",
    ":where(.fcms-image){display:block;max-width:100%;height:auto}",
    ":where(.fcms-entry) :where(.fcms-title){margin:0 0 .25em}",
    ":where(.fcms-body img){max-width:100%;height:auto}",
    ":where(.fcms-pager){display:flex;flex-wrap:wrap;gap:.5em;margin-top:1em}",
    ":where(.fcms-pager a){color:inherit}",
    ":where(.fcms-pager-current){font-weight:700}",
    ":where(.fcms-more){margin-top:1em;font:inherit;cursor:pointer}",
    ":where(ul.fcms-items){list-style:none;margin:0;padding:0}",
  ].join("\n");
  var HEADINGS = { h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };

  function warn(err) {
    if (typeof console !== "undefined" && console.warn) console.warn("[femtocms]", err);
  }

  function resolveBase() {
    if (typeof window.FEMTOCMS_BASE === "string" && window.FEMTOCMS_BASE) return window.FEMTOCMS_BASE.replace(/\/+$/, "");
    if (script && script.src) return new URL(script.src, document.baseURI).origin;
    return "";
  }
  var base = resolveBase();

  function ensureStyle() {
    if (document.getElementById("fcms-style")) return;
    var style = document.createElement("style");
    style.id = "fcms-style";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function clampLimit(raw) {
    var n = parseInt(raw, 10);
    if (isNaN(n)) return 5;
    return Math.min(100, Math.max(1, n));
  }

  // data-filter="category=menu&price[gte]=1000" → filter[category]=menu & filter[price][gte]=1000
  function applyFilter(url, raw) {
    if (!raw) return;
    raw.split("&").forEach(function (part) {
      var eq = part.indexOf("=");
      if (eq < 1) return;
      var key = part.slice(0, eq).trim();
      var m = /^([A-Za-z][A-Za-z0-9_]*)(?:\[([a-z]+)\])?$/.exec(key);
      if (!m) return warn("ignored data-filter part: " + part);
      url.searchParams.set("filter[" + m[1] + "]" + (m[2] ? "[" + m[2] + "]" : ""), part.slice(eq + 1).trim());
    });
  }

  function applyExpand(url, expand) {
    if (expand && expand.length) url.searchParams.set("expand", expand.join(","));
  }

  function buildUrl(collection, limit, offset, filter, expand) {
    var url = new URL(base + "/api/" + encodeURIComponent(collection));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "-publishedAt");
    if (offset !== null) url.searchParams.set("offset", String(offset));
    applyFilter(url, filter);
    applyExpand(url, expand);
    return url.toString();
  }

  function isJapanese(el) {
    return /^ja/i.test(el.getAttribute("data-locale") || document.documentElement.lang || "");
  }

  function pageNumber(el) {
    var n = parseInt(new URLSearchParams(window.location.search).get(el.getAttribute("data-page-param") || "page") || "", 10);
    return isNaN(n) || n < 1 ? 1 : n;
  }

  // 1 … 9 10 11 … 20 : first, last, and the current page with its neighbours.
  function pageWindow(current, pages) {
    var out = [];
    for (var p = 1; p <= pages; p++) {
      if (pages <= 7 || p === 1 || p === pages || Math.abs(p - current) <= 1) out.push(p);
      else if (out[out.length - 1] !== 0) out.push(0);
    }
    return out;
  }

  // Only relative URLs and http(s) are linkable; control characters are stripped first because browsers ignore them inside schemes.
  function safeHref(href) {
    var probe = href.replace(/[\u0000- ]/g, "");
    if (!probe) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(probe) && !/^https?:/i.test(probe)) return "";
    return href.trim();
  }

  function buildHref(template, item) {
    if (!template) return "";
    var slug = item.slug || item.id || "";
    var id = item.id || "";
    return safeHref(template.replace(/\{slug\}/g, encodeURIComponent(slug)).replace(/\{id\}/g, encodeURIComponent(id)));
  }

  function className(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, "");
  }

  function formatDate(d, locale) {
    try {
      return d.toLocaleDateString(locale || undefined);
    } catch (e) {
      return d.toLocaleDateString();
    }
  }

  function isMedia(v) {
    return !!v && typeof v === "object" && typeof v.url === "string" && /^https?:\/\//i.test(v.url);
  }

  function localeOf(el) {
    return el.getAttribute("data-locale") || document.documentElement.lang || "";
  }

  function renderField(name, item, locale) {
    if (DATE_FIELDS[name] === 1) {
      var raw = item[name];
      var d = typeof raw === "string" ? new Date(raw) : null;
      if (!d || isNaN(d.getTime())) return null;
      var time = document.createElement("time");
      time.className = "fcms-date";
      time.setAttribute("datetime", raw);
      time.textContent = formatDate(d, locale);
      return time;
    }
    var cls = className(name);
    if (!cls) return null;
    var value = item.data ? item.data[name] : undefined;
    if (typeof value === "string" || typeof value === "number") {
      var text = String(value);
      if (!text) return null;
      var span = document.createElement("span");
      span.className = name === "title" ? "fcms-title" : "fcms-field fcms-field-" + cls;
      span.textContent = text;
      return span;
    }
    if (isMedia(value)) {
      var img = document.createElement("img");
      img.className = "fcms-image";
      img.setAttribute("src", value.url);
      img.setAttribute("alt", typeof value.alt === "string" ? value.alt : "");
      img.setAttribute("loading", "lazy");
      return img;
    }
    return null;
  }

  // ---- templates ----------------------------------------------------------------------------
  // Values go in as text. The only markup inserted is item.html[field] (Markdown the CMS rendered with raw HTML escaped).
  var BUILTIN = { id: 1, slug: 1, status: 1, publishedAt: 1, createdAt: 1, updatedAt: 1 };
  var NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
  var ENTRY_ID_RE = /^e_[0-9a-z]{12}$/;
  var PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_.]*)\}/g;
  var templates = new WeakMap();

  // The element's own <template> child; remembered, because rendering replaces the element's children.
  function templateOf(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName === "TEMPLATE" && !c.hasAttribute("data-each")) {
        templates.set(el, c);
        break;
      }
    }
    return templates.get(el) || null;
  }

  function own(o, k) {
    return o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  }

  function isEntry(v) {
    return !!v && typeof v === "object" && !Array.isArray(v) && !!v.data && typeof v.data === "object";
  }

  function remove(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  // "title", "author.name", or "." (the scope itself, inside data-each). An entry exposes its built-ins and its data fields.
  function lookup(scope, path) {
    if (path === ".") return { value: scope };
    var parts = path.split(".");
    var v = scope;
    var parent = null;
    for (var i = 0; i < parts.length; i++) {
      if (!NAME_RE.test(parts[i])) return {};
      if (i > 0 && typeof v === "string" && ENTRY_ID_RE.test(v)) {
        warn("\"" + path + "\": the reference was not expanded (only top-level reference fields can be)");
        return {};
      }
      parent = v;
      v = isEntry(v) ? (BUILTIN[parts[i]] === 1 ? own(v, parts[i]) : own(v.data, parts[i])) : Array.isArray(v) ? undefined : own(v, parts[i]);
      if (v === undefined || v === null) return {};
    }
    var html = isEntry(parent) ? own(parent.html, parts[parts.length - 1]) : undefined;
    return { value: v, html: typeof html === "string" ? html : undefined };
  }

  function textOf(v) {
    if (typeof v === "string") return v;
    if (typeof v === "number" && isFinite(v)) return String(v);
    if (Array.isArray(v)) {
      var parts = v.filter(function (x) { return typeof x === "string" || (typeof x === "number" && isFinite(x)); });
      return parts.length === v.length ? parts.map(String).join(", ") : "";
    }
    return "";
  }

  function present(v) {
    return !(v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0));
  }

  function bindField(node, scope, locale) {
    var r = lookup(scope, node.getAttribute("data-field"));
    var v = r.value;
    if (node.tagName === "IMG") {
      if (!isMedia(v)) return remove(node);
      node.setAttribute("src", v.url);
      if (!node.hasAttribute("alt")) node.setAttribute("alt", typeof v.alt === "string" ? v.alt : "");
      if (typeof v.width === "number" && !node.hasAttribute("width")) node.setAttribute("width", String(v.width));
      if (typeof v.height === "number" && !node.hasAttribute("height")) node.setAttribute("height", String(v.height));
      if (!node.hasAttribute("loading")) node.setAttribute("loading", "lazy");
      return;
    }
    if (r.html !== undefined) {
      node.innerHTML = r.html;
      return;
    }
    if (node.tagName === "TIME" && typeof v === "string") {
      var d = new Date(v);
      if (!isNaN(d.getTime())) {
        node.setAttribute("datetime", v);
        node.textContent = formatDate(d, locale);
        return;
      }
    }
    node.textContent = textOf(v);
  }

  // data-class="category soldOut": category-menu for a value, soldOut for true.
  function bindClass(node, scope) {
    node.getAttribute("data-class").split(/\s+/).filter(Boolean).forEach(function (name) {
      var v = lookup(scope, name).value;
      var prefix = className(name.replace(/\./g, "-"));
      if (!prefix) return;
      if (v === true) return node.classList.add(prefix);
      (Array.isArray(v) ? v : [v]).forEach(function (x) {
        var s = typeof x === "string" || typeof x === "number" ? className(String(x)) : "";
        if (s) node.classList.add(prefix + "-" + s);
      });
    });
  }

  function bindHref(node, scope) {
    var href = safeHref(node.getAttribute("data-href").replace(PLACEHOLDER_RE, function (_, name) {
      var v = lookup(scope, name).value;
      if (name === "slug" && !present(v)) v = lookup(scope, "id").value;
      return encodeURIComponent(textOf(v));
    }));
    if (href) node.setAttribute("href", href);
  }

  function fill(root, scope, locale) {
    // Both lists are taken before data-each inserts its copies, which were already filled with their own scope.
    var nodes = root.querySelectorAll("[data-field],[data-if],[data-class],[data-href]");
    var eaches = root.querySelectorAll("template[data-each]");
    for (var i = 0; i < eaches.length; i++) {
      var tpl = eaches[i];
      var list = lookup(scope, tpl.getAttribute("data-each")).value;
      if (Array.isArray(list)) {
        list.forEach(function (item) {
          var copy = tpl.content.cloneNode(true);
          fill(copy, item, locale);
          tpl.parentNode.insertBefore(copy, tpl);
        });
      }
      remove(tpl);
    }
    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j];
      if (node.tagName === "TEMPLATE") continue;
      if (node.hasAttribute("data-if")) {
        var cond = node.getAttribute("data-if");
        var negate = cond.charAt(0) === "!";
        if (present(lookup(scope, negate ? cond.slice(1) : cond).value) === negate) {
          remove(node);
          continue;
        }
      }
      if (node.hasAttribute("data-field")) bindField(node, scope, locale);
      if (node.hasAttribute("data-class")) bindClass(node, scope);
      if (node.hasAttribute("data-href")) bindHref(node, scope);
    }
  }

  // Reference fields the template reads through ("author.name", or data-each="related"): fetched with ?expand=.
  function expandsOf(tpl) {
    if (!tpl) return [];
    var out = [];
    function add(path, whole) {
      var dot = path.indexOf(".");
      var head = dot > 0 ? path.slice(0, dot) : whole ? path : "";
      if (NAME_RE.test(head) && out.indexOf(head) < 0) out.push(head);
    }
    function each(sel, fn) {
      var found = tpl.content.querySelectorAll(sel);
      for (var i = 0; i < found.length; i++) fn(found[i]);
    }
    each("[data-field]", function (n) { add(n.getAttribute("data-field")); });
    each("[data-if]", function (n) { add(n.getAttribute("data-if").replace(/^!/, "")); });
    each("[data-class]", function (n) { n.getAttribute("data-class").split(/\s+/).forEach(function (s) { add(s); }); });
    each("[data-href]", function (n) { n.getAttribute("data-href").replace(PLACEHOLDER_RE, function (_, p) { add(p); return ""; }); });
    each("template[data-each]", function (n) { add(n.getAttribute("data-each"), true); });
    return out;
  }

  function itemsContainer(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.classList.contains("fcms-list") || c.classList.contains("fcms-items")) return c;
    }
    return null;
  }

  function appendItems(el, ul, items) {
    var tpl = templateOf(el);
    if (tpl) {
      var loc = localeOf(el);
      items.forEach(function (item) {
        var copy = tpl.content.cloneNode(true);
        fill(copy, item, loc);
        ul.appendChild(copy);
      });
      return;
    }
    var fields = (el.getAttribute("data-fields") || "publishedAt,title")
      .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var locale = localeOf(el);
    var template = el.getAttribute("data-href") || "";
    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "fcms-item";
      var parent = li;
      var href = buildHref(template, item);
      if (href) {
        var a = document.createElement("a");
        a.className = "fcms-link";
        a.setAttribute("href", href);
        li.appendChild(a);
        parent = a;
      }
      fields.forEach(function (name) {
        var node = renderField(name, item, locale);
        if (node) parent.appendChild(node);
      });
      ul.appendChild(li);
    });
  }

  function renderList(el, items) {
    var tpl = templateOf(el);
    var first = tpl && tpl.content.firstElementChild;
    var ul = document.createElement(!tpl || (first && first.tagName === "LI") ? "ul" : "div");
    ul.className = tpl ? "fcms-items" : "fcms-list";
    appendItems(el, ul, items);
    el.textContent = "";
    el.appendChild(ul);
  }

  function pageHref(el, page) {
    var params = new URLSearchParams(window.location.search);
    params.set(el.getAttribute("data-page-param") || "page", String(page));
    return "?" + params.toString();
  }

  function renderPager(el, current, pages) {
    var ja = isJapanese(el);
    var nav = document.createElement("nav");
    nav.className = "fcms-pager";
    nav.setAttribute("aria-label", ja ? "ページ" : "Pages");
    function link(page, label, cls) {
      var a = document.createElement("a");
      a.className = cls;
      a.setAttribute("href", pageHref(el, page));
      a.textContent = label;
      nav.appendChild(a);
    }
    if (current > 1) link(Math.min(current - 1, pages), el.getAttribute("data-prev-label") || (ja ? "‹ 前へ" : "‹ Prev"), "fcms-pager-prev");
    pageWindow(current, pages).forEach(function (p) {
      if (p === 0) {
        var gap = document.createElement("span");
        gap.className = "fcms-pager-gap";
        gap.textContent = "…";
        nav.appendChild(gap);
      } else if (p === current) {
        var cur = document.createElement("span");
        cur.className = "fcms-pager-page fcms-pager-current";
        cur.setAttribute("aria-current", "page");
        cur.textContent = String(p);
        nav.appendChild(cur);
      } else {
        link(p, String(p), "fcms-pager-page");
      }
    });
    if (current < pages) link(current + 1, el.getAttribute("data-next-label") || (ja ? "次へ ›" : "Next ›"), "fcms-pager-next");
    el.appendChild(nav);
  }

  // State for data-pager="more": how far each element has loaded.
  var moreState = new WeakMap();

  function renderMoreButton(el) {
    var state = moreState.get(el);
    var old = el.querySelector("button.fcms-more");
    if (!state || state.offset >= state.total) {
      if (old) old.parentNode.removeChild(old);
      return;
    }
    if (old) return;
    var btn = document.createElement("button");
    btn.className = "fcms-more";
    btn.setAttribute("type", "button");
    btn.textContent = el.getAttribute("data-more-label") || (isJapanese(el) ? "もっと見る" : "Load more");
    btn.addEventListener("click", function () { more(el); });
    el.appendChild(btn);
  }

  function more(el) {
    var state = moreState.get(el);
    if (!state || state.loading || state.offset >= state.total) return Promise.resolve();
    state.loading = true;
    var btn = el.querySelector("button.fcms-more");
    if (btn) btn.setAttribute("disabled", "");
    return Promise.resolve()
      .then(function () { return fetch(buildUrl(state.collection, state.limit, state.offset, state.filter, state.expand), { credentials: "omit" }); })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + state.collection);
        return res.json();
      })
      .then(function (body) {
        if (moreState.get(el) !== state) return;
        if (!body || !Array.isArray(body.items)) throw new Error("unexpected response for " + state.collection);
        var ul = itemsContainer(el);
        if (ul) appendItems(el, ul, body.items);
        state.offset += body.items.length;
        if (typeof body.total === "number") state.total = body.total;
        if (!body.items.length) state.offset = state.total;
      })
      .catch(warn)
      .then(function () {
        state.loading = false;
        var b = el.querySelector("button.fcms-more");
        if (b) b.removeAttribute("disabled");
        renderMoreButton(el);
      });
  }

  function renderEmpty(el) {
    el.textContent = "";
    var message = el.getAttribute("data-empty");
    if (!message) return;
    var p = document.createElement("p");
    p.className = "fcms-empty";
    p.textContent = message;
    el.appendChild(p);
  }

  function fieldList(el, fallback) {
    var raw = el.getAttribute("data-fields");
    var list = raw ? raw.split(",") : fallback;
    return list.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // Detail view. The only HTML inserted as markup is item.html[field]: the CMS renders it from Markdown with raw HTML escaped and unsafe URLs removed.
  function renderEntry(el, item) {
    var locale = localeOf(el);
    var tpl = templateOf(el);
    if (tpl) {
      var copy = tpl.content.cloneNode(true);
      fill(copy, item, locale);
      el.textContent = "";
      el.appendChild(copy);
      setDocumentTitle(el, item);
      return;
    }
    var html = item.html && typeof item.html === "object" ? item.html : {};
    var fields = fieldList(el, ["title", "publishedAt"].concat(Object.keys(html)));
    var heading = (el.getAttribute("data-heading") || "h1").toLowerCase();
    if (HEADINGS[heading] !== 1) heading = "h1";
    var article = document.createElement("article");
    article.className = "fcms-entry";
    fields.forEach(function (name) {
      var node = null;
      var title = item.data ? item.data.title : undefined;
      if (Object.prototype.hasOwnProperty.call(html, name) && typeof html[name] === "string") {
        var cls = className(name);
        node = document.createElement("div");
        node.className = "fcms-body" + (cls ? " fcms-field-" + cls : "");
        node.innerHTML = html[name];
      } else if (name === "title" && (typeof title === "string" || typeof title === "number") && String(title)) {
        node = document.createElement(heading);
        node.className = "fcms-title";
        node.textContent = String(title);
      } else {
        node = renderField(name, item, locale);
      }
      if (node) article.appendChild(node);
    });
    el.textContent = "";
    el.appendChild(article);
    setDocumentTitle(el, item);
  }

  function setDocumentTitle(el, item) {
    var docTitle = item.data ? item.data.title : undefined;
    if (el.hasAttribute("data-document-title") && typeof docTitle === "string" && docTitle) {
      document.title = document.title ? docTitle + " | " + document.title : docTitle;
    }
  }

  function entryKey(el) {
    var fixed = el.getAttribute("data-slug");
    if (fixed) return fixed;
    var params = new URLSearchParams(window.location.search);
    return params.get(el.getAttribute("data-param") || "slug") || "";
  }

  function buildEntryUrl(collection, key, expand) {
    var url = new URL(base + "/api/" + encodeURIComponent(collection) + "/" + encodeURIComponent(key));
    var preview = new URLSearchParams(window.location.search).get("preview");
    if (preview) url.searchParams.set("preview", preview);
    applyExpand(url, expand);
    return url.toString();
  }

  var latest = new WeakMap();

  function renderEntryElement(el) {
    var token = {};
    latest.set(el, token);
    var collection = el.getAttribute("data-femtocms-entry");
    if (!collection) return Promise.resolve();
    var key = entryKey(el);
    var expand = expandsOf(templateOf(el));
    if (!key) {
      renderEmpty(el);
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(function () { return fetch(buildEntryUrl(collection, key, expand), { credentials: "omit" }); })
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + collection + "/" + key);
        return res.json();
      })
      .then(function (body) {
        if (latest.get(el) !== token) return;
        if (body === null) return renderEmpty(el);
        if (!body || typeof body !== "object" || !body.data) throw new Error("unexpected response for " + collection + "/" + key);
        renderEntry(el, body);
      })
      .catch(warn);
  }

  function renderElement(el) {
    var token = {};
    latest.set(el, token);
    var collection = el.getAttribute("data-femtocms");
    if (!collection) return Promise.resolve();
    moreState.delete(el);
    var limit = clampLimit(el.getAttribute("data-limit"));
    var pager = el.getAttribute("data-pager");
    var filter = el.getAttribute("data-filter") || "";
    var page = pager === "pages" ? pageNumber(el) : 1;
    var offset = pager === "pages" || pager === "more" ? (page - 1) * limit : null;
    var expand = expandsOf(templateOf(el));
    return Promise.resolve()
      .then(function () { return fetch(buildUrl(collection, limit, offset, filter, expand), { credentials: "omit" }); })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + collection);
        return res.json();
      })
      .then(function (body) {
        if (!body || !Array.isArray(body.items)) throw new Error("unexpected response for " + collection);
        // A newer render of the same element supersedes this one.
        if (latest.get(el) !== token) return;
        if (body.items.length) renderList(el, body.items);
        else renderEmpty(el);
        var total = typeof body.total === "number" ? body.total : body.items.length;
        if (pager === "pages") {
          var pages = Math.ceil(total / limit);
          if (pages > 1) renderPager(el, page, pages);
        } else if (pager === "more" && body.items.length) {
          moreState.set(el, { collection: collection, limit: limit, filter: filter, expand: expand, offset: body.items.length, total: total, loading: false });
          renderMoreButton(el);
        }
      })
      .catch(warn);
  }

  function refresh() {
    var lists = document.querySelectorAll("[data-femtocms]");
    var entries = document.querySelectorAll("[data-femtocms-entry]");
    if (!lists.length && !entries.length) return Promise.resolve();
    if (!base) {
      warn("cannot determine the femtocms origin; set window.FEMTOCMS_BASE or load this file via <script src>");
      return Promise.resolve();
    }
    ensureStyle();
    var jobs = [];
    for (var i = 0; i < lists.length; i++) jobs.push(renderElement(lists[i]));
    for (var j = 0; j < entries.length; j++) jobs.push(renderEntryElement(entries[j]));
    return Promise.all(jobs).then(function () {});
  }

  window.femtocms = { refresh: refresh, more: more };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { refresh(); });
  else refresh();
})();
