/* femtocms embed. No dependencies.
   [data-femtocms="<collection>"]        renders a list of entries.
   [data-femtocms-entry="<collection>"]  renders one entry: ?slug= in the page URL, data-slug, or the entry of a "single" collection.
   <template> children replace the built-in markup. Their role comes from an attribute:
     <template>                one entry       (data-field / data-if / data-class / data-href / <template data-each>)
     <template data-pager>     page numbers or "load more" (data-page / data-more)
     <template data-prevnext>  links to the older and newer entry (data-page)
     <template data-empty>     nothing to show
     <template data-error>     loading failed */
(function () {
  "use strict";
  if (window.femtocms) return;

  var script = document.currentScript;
  var DATE_FIELDS = { publishedAt: 1, createdAt: 1, updatedAt: 1 };
  var BUILTIN = { id: 1, slug: 1, status: 1, publishedAt: 1, createdAt: 1, updatedAt: 1 };
  var HEADINGS = { h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
  var NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
  var ENTRY_ID_RE = /^e_[0-9a-z]{12}$/;
  var PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_.]*)\}/g;
  var SORT_RE = /^-?[A-Za-z][A-Za-z0-9_]*(,-?[A-Za-z][A-Za-z0-9_]*)*$/;
  var DEFAULT_SORT = "-publishedAt";
  var ROLES = ["pager", "prevnext", "empty", "error"];
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
    ":where(.fcms-prevnext){display:flex;flex-wrap:wrap;justify-content:space-between;gap:1em;margin-top:2em}",
    ":where(.fcms-prevnext a){color:inherit}",
    ":where(.fcms-next){margin-left:auto;text-align:right}",
  ].join("\n");

  // ---- basics ------------------------------------------------------------------------------

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

  function sortOf(el) {
    var raw = (el.getAttribute("data-sort") || "").replace(/\s+/g, "");
    if (!raw) return DEFAULT_SORT;
    if (SORT_RE.test(raw)) return raw;
    warn("ignored data-sort: " + raw);
    return DEFAULT_SORT;
  }

  function localeOf(el) {
    return el.getAttribute("data-locale") || document.documentElement.lang || "";
  }

  function isJapanese(el) {
    return /^ja/i.test(localeOf(el));
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

  function own(o, k) {
    return o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  }

  function isEntry(v) {
    return !!v && typeof v === "object" && !Array.isArray(v) && !!v.data && typeof v.data === "object";
  }

  function remove(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function className(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, "");
  }

  // Only relative URLs and http(s) are linkable; control characters are stripped first because browsers ignore them inside schemes.
  function safeHref(href) {
    var probe = href.replace(/[\u0000- ]/g, "");
    if (!probe) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(probe) && !/^https?:/i.test(probe)) return "";
    return href.trim();
  }

  // "news.html?slug={slug}&c={category}" — values are URL-encoded; {slug} falls back to the id.
  function hrefFrom(template, scope) {
    return safeHref(template.replace(PLACEHOLDER_RE, function (_, name) {
      var v = lookup(scope, name).value;
      if (name === "slug" && !present(v)) v = lookup(scope, "id").value;
      return encodeURIComponent(textOf(v));
    }));
  }

  // ---- URLs --------------------------------------------------------------------------------

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

  function collectionUrl(collection) {
    return new URL(base + "/api/" + encodeURIComponent(collection));
  }

  // q: { limit, sort, offset (null for none), filter, expand }
  function listUrl(collection, q) {
    var url = collectionUrl(collection);
    url.searchParams.set("limit", String(q.limit));
    url.searchParams.set("sort", q.sort);
    if (q.offset !== null) url.searchParams.set("offset", String(q.offset));
    applyFilter(url, q.filter);
    applyExpand(url, q.expand);
    return url.toString();
  }

  function entryUrl(collection, key, expand) {
    var url = new URL(base + "/api/" + encodeURIComponent(collection) + "/" + encodeURIComponent(key));
    var preview = new URLSearchParams(window.location.search).get("preview");
    if (preview) url.searchParams.set("preview", preview);
    applyExpand(url, expand);
    return url.toString();
  }

  // No key: a "single" collection answers with its entry; a list collection answers with { items } (= nothing to show).
  function singleUrl(collection, expand) {
    var url = collectionUrl(collection);
    url.searchParams.set("limit", "1");
    applyExpand(url, expand);
    return url.toString();
  }

  // The entry published just before ("lt") or just after ("gt") the given time.
  function neighborUrl(collection, op, publishedAt, filter) {
    var url = collectionUrl(collection);
    url.searchParams.set("limit", "1");
    url.searchParams.set("sort", op === "lt" ? "-publishedAt" : "publishedAt");
    applyFilter(url, filter);
    url.searchParams.set("filter[publishedAt][" + op + "]", publishedAt);
    return url.toString();
  }

  // missingOk: a 404 resolves to null (an entry that does not exist) instead of failing.
  function getJson(url, what, missingOk) {
    return fetch(url, { credentials: "omit" }).then(function (res) {
      if (missingOk && res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + what);
      return res.json();
    });
  }

  // ---- templates ---------------------------------------------------------------------------
  // Values go in as text. The only markup inserted is item.html[field] (Markdown the CMS rendered with raw HTML escaped).

  var templateSets = new WeakMap();

  // Entries exactly as the API returned them (list items, the entry, its neighbours). Only their html is markup:
  // an object of the same shape found inside data (a json or list field, an expanded reference) stays text.
  var trusted = new WeakSet();

  function trust(o) {
    if (o && typeof o === "object") trusted.add(o);
    return o;
  }

  // The element's own <template> children by role; remembered, because rendering replaces the element's children.
  function templatesOf(el) {
    var found = null;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName !== "TEMPLATE" || c.hasAttribute("data-each")) continue;
      var role = "item";
      for (var i = 0; i < ROLES.length; i++) {
        if (c.hasAttribute("data-" + ROLES[i])) {
          role = ROLES[i];
          break;
        }
      }
      found = found || {};
      if (!found[role]) found[role] = c;
    }
    if (found) templateSets.set(el, found);
    return templateSets.get(el) || {};
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
    var html = isEntry(parent) && trusted.has(parent) ? own(parent.html, parts[parts.length - 1]) : undefined;
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

  // env: { locale, page: function (node, scope) } — page handles data-page inside pager / prevnext templates.
  function fill(root, scope, env) {
    // Both lists are taken before data-each inserts its copies, which were already filled with their own scope.
    var nodes = root.querySelectorAll("[data-field],[data-if],[data-class],[data-href],[data-page]");
    var eaches = root.querySelectorAll("template[data-each]");
    for (var i = 0; i < eaches.length; i++) {
      var tpl = eaches[i];
      var list = lookup(scope, tpl.getAttribute("data-each")).value;
      if (Array.isArray(list)) {
        list.forEach(function (item) {
          tpl.parentNode.insertBefore(stamp(tpl, item, env), tpl);
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
      if (node.hasAttribute("data-field")) bindField(node, scope, env.locale);
      if (node.hasAttribute("data-class")) bindClass(node, scope);
      if (node.hasAttribute("data-href")) {
        var href = hrefFrom(node.getAttribute("data-href"), scope);
        if (href) node.setAttribute("href", href);
      }
      if (node.hasAttribute("data-page") && env.page) env.page(node, scope);
    }
  }

  function stamp(tpl, scope, env) {
    var copy = tpl.content.cloneNode(true);
    fill(copy, scope, env);
    return copy;
  }

  // A filled template placed at the end of el inside div.<cls>, replacing an earlier one.
  function renderBlock(el, tpl, cls, scope, env) {
    remove(childWithClass(el, cls));
    var wrap = document.createElement("div");
    wrap.className = cls;
    wrap.appendChild(stamp(tpl, scope, env));
    el.appendChild(wrap);
    return wrap;
  }

  function childWithClass(el, cls) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.classList.contains(cls)) return c;
    }
    return null;
  }

  // Replaces el's content with a filled template (empty / error states).
  function renderState(el, tpl) {
    el.textContent = "";
    el.appendChild(stamp(tpl, {}, { locale: localeOf(el) }));
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

  // ---- built-in markup ---------------------------------------------------------------------

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

  function fieldList(el, fallback) {
    var raw = el.getAttribute("data-fields");
    var list = raw ? raw.split(",") : fallback;
    return list.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // ---- lists -------------------------------------------------------------------------------

  function appendItems(el, ul, items) {
    var tpl = templatesOf(el).item;
    var locale = localeOf(el);
    if (tpl) {
      items.forEach(function (item) { ul.appendChild(stamp(tpl, item, { locale: locale })); });
      return;
    }
    var fields = fieldList(el, ["publishedAt", "title"]);
    var template = el.getAttribute("data-href") || "";
    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "fcms-item";
      var parent = li;
      var href = template ? hrefFrom(template, item) : "";
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

  // Template copies go into ul.fcms-items when the template is an <li>, else div.fcms-items; built-in rows into ul.fcms-list.
  function renderList(el, items) {
    var tpl = templatesOf(el).item;
    var first = tpl && tpl.content.firstElementChild;
    var ul = document.createElement(!tpl || (first && first.tagName === "LI") ? "ul" : "div");
    ul.className = tpl ? "fcms-items" : "fcms-list";
    appendItems(el, ul, items);
    el.textContent = "";
    el.appendChild(ul);
  }

  function itemsContainer(el) {
    return childWithClass(el, "fcms-items") || childWithClass(el, "fcms-list");
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

  function pageHref(el, page) {
    var params = new URLSearchParams(window.location.search);
    params.set(el.getAttribute("data-page-param") || "page", String(page));
    return "?" + params.toString();
  }

  function disableLink(node) {
    node.removeAttribute("href");
    node.setAttribute("aria-disabled", "true");
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

  // data-page="prev|next|first|last", or a bare data-page inside data-each="pages" for that page.
  function renderPagesTemplate(el, tpl, current, pages, total) {
    var scope = {
      current: current, totalPages: pages, total: total, hasPrev: current > 1, hasNext: current < pages,
      pages: pageWindow(current, pages).map(function (p) { return p === 0 ? { gap: true } : { number: p, current: p === current, gap: false }; }),
    };
    renderBlock(el, tpl, "fcms-pager-custom", scope, {
      locale: localeOf(el),
      page: function (node, s) {
        var which = node.getAttribute("data-page");
        var target = which === "prev" ? Math.min(current - 1, pages) : which === "next" ? current + 1 : which === "first" ? 1 : which === "last" ? pages
          : which === "" && typeof s.number === "number" ? s.number : 0;
        if (target < 1 || target > pages) return disableLink(node);
        node.setAttribute("href", pageHref(el, target));
        if (target === current && which === "") node.setAttribute("aria-current", "page");
      },
    });
  }

  // State for data-pager="more": how far each element has loaded.
  var moreState = new WeakMap();

  function renderMoreButton(el) {
    var state = moreState.get(el);
    var done = !state || state.offset >= state.total;
    var tpl = templatesOf(el).pager;
    if (tpl) {
      if (done) return remove(childWithClass(el, "fcms-pager-custom"));
      var wrap = renderBlock(el, tpl, "fcms-pager-custom", { loaded: state.offset, total: state.total, remaining: state.total - state.offset }, { locale: localeOf(el) });
      var buttons = wrap.querySelectorAll("[data-more]");
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener("click", function (e) {
          e.preventDefault();
          more(el);
        });
      }
      return;
    }
    var old = el.querySelector("button.fcms-more");
    if (done) return remove(old);
    if (old) return;
    var btn = document.createElement("button");
    btn.className = "fcms-more";
    btn.setAttribute("type", "button");
    btn.textContent = el.getAttribute("data-more-label") || (isJapanese(el) ? "もっと見る" : "Load more");
    btn.addEventListener("click", function () { more(el); });
    el.appendChild(btn);
  }

  function moreButtons(el) {
    var wrap = childWithClass(el, "fcms-pager-custom");
    return Array.prototype.slice.call(wrap ? wrap.querySelectorAll("[data-more]") : el.querySelectorAll("button.fcms-more"));
  }

  function more(el) {
    var state = moreState.get(el);
    if (!state || state.loading || state.offset >= state.total) return Promise.resolve();
    state.loading = true;
    moreButtons(el).forEach(function (b) { b.setAttribute("disabled", ""); });
    return Promise.resolve()
      .then(function () {
        return getJson(listUrl(state.collection, { limit: state.limit, sort: state.sort, offset: state.offset, filter: state.filter, expand: state.expand }), state.collection);
      })
      .then(function (body) {
        if (moreState.get(el) !== state) return;
        if (!body || !Array.isArray(body.items)) throw new Error("unexpected response for " + state.collection);
        body.items.forEach(trust);
        var ul = itemsContainer(el);
        if (ul) appendItems(el, ul, body.items);
        state.offset += body.items.length;
        if (typeof body.total === "number") state.total = body.total;
        if (!body.items.length) state.offset = state.total;
      })
      .catch(warn)
      .then(function () {
        state.loading = false;
        moreButtons(el).forEach(function (b) { b.removeAttribute("disabled"); });
        renderMoreButton(el);
      });
  }

  // ---- entries -----------------------------------------------------------------------------

  function entryKey(el) {
    var fixed = el.getAttribute("data-slug");
    if (fixed) return fixed;
    return new URLSearchParams(window.location.search).get(el.getAttribute("data-param") || "slug") || "";
  }

  // A link to another entry: data-href on the element, else this page with ?slug= (or data-param) swapped.
  function entryLink(el, e) {
    var template = el.getAttribute("data-href");
    if (template) return hrefFrom(template, e);
    var key = e.slug || e.id;
    if (!key) return "";
    var params = new URLSearchParams(window.location.search);
    params.delete("preview");
    params.set(el.getAttribute("data-param") || "slug", key);
    return "?" + params.toString();
  }

  // The page's own title, taken before the first change, so re-renders replace the entry part instead of stacking it.
  var baseTitle = null;

  function setDocumentTitle(el, item) {
    if (!el.hasAttribute("data-document-title")) return;
    if (baseTitle === null) baseTitle = document.title;
    var docTitle = item && item.data ? item.data.title : undefined;
    if (typeof docTitle === "string" && docTitle) document.title = baseTitle ? docTitle + " | " + baseTitle : docTitle;
    else document.title = baseTitle;
  }

  // Detail view. The only HTML inserted as markup is item.html[field]: the CMS renders it from Markdown with raw HTML escaped and unsafe URLs removed.
  function renderEntry(el, item) {
    var locale = localeOf(el);
    var tpl = templatesOf(el).item;
    if (tpl) {
      var copy = stamp(tpl, item, { locale: locale });
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

  function firstItem(url, what) {
    return getJson(url, what)
      .then(function (body) { return body && Array.isArray(body.items) && body.items[0] ? trust(body.items[0]) : null; })
      .catch(function (err) {
        warn(err);
        return null;
      });
  }

  // prev = the entry published just before this one (older), next = just after (newer). Published entries only.
  function renderPrevNext(el, collection, item, token) {
    var tpl = templatesOf(el).prevnext;
    if (!tpl && !el.hasAttribute("data-prevnext")) return null;
    if (item.status !== "published" || typeof item.publishedAt !== "string") return null;
    var filter = el.getAttribute("data-filter") || "";
    return Promise.all([
      firstItem(neighborUrl(collection, "lt", item.publishedAt, filter), collection),
      firstItem(neighborUrl(collection, "gt", item.publishedAt, filter), collection),
    ]).then(function (found) {
      if (latest.get(el) !== token) return;
      var prev = found[0];
      var next = found[1];
      if (!prev && !next) return;
      if (tpl) {
        renderBlock(el, tpl, "fcms-prevnext-custom", { prev: prev, next: next }, {
          locale: localeOf(el),
          page: function (node) {
            var which = node.getAttribute("data-page");
            var target = which === "prev" ? prev : which === "next" ? next : null;
            var href = target ? entryLink(el, target) : "";
            if (href) node.setAttribute("href", href);
            else disableLink(node);
          },
        });
        return;
      }
      var ja = isJapanese(el);
      var nav = document.createElement("nav");
      nav.className = "fcms-prevnext";
      nav.setAttribute("aria-label", ja ? "前後の記事" : "More entries");
      [[prev, "fcms-prev", "prev", "‹ ", ""], [next, "fcms-next", "next", "", " ›"]].forEach(function (p) {
        var href = p[0] ? entryLink(el, p[0]) : "";
        if (!href) return;
        var a = document.createElement("a");
        a.className = p[1];
        a.setAttribute("href", href);
        a.setAttribute("rel", p[2]);
        a.textContent = p[3] + (textOf(lookup(p[0], "title").value) || p[0].slug || p[0].id) + p[4];
        nav.appendChild(a);
      });
      if (nav.firstChild) el.appendChild(nav);
    });
  }

  // ---- states ------------------------------------------------------------------------------

  function renderEmpty(el) {
    var tpl = templatesOf(el).empty;
    if (tpl) return renderState(el, tpl);
    el.textContent = "";
    var message = el.getAttribute("data-empty");
    if (!message) return;
    var p = document.createElement("p");
    p.className = "fcms-empty";
    p.textContent = message;
    el.appendChild(p);
  }

  // Without <template data-error> the element is left as it was (any loading text stays).
  function renderError(el, token, err) {
    warn(err);
    if (latest.get(el) !== token) return;
    setDocumentTitle(el, null);
    var tpl = templatesOf(el).error;
    if (tpl) renderState(el, tpl);
  }

  // ---- driver ------------------------------------------------------------------------------

  var latest = new WeakMap();

  function renderElement(el) {
    var token = {};
    latest.set(el, token);
    var collection = el.getAttribute("data-femtocms");
    if (!collection) return Promise.resolve();
    var tpls = templatesOf(el); // read before rendering replaces the children
    moreState.delete(el);
    var limit = clampLimit(el.getAttribute("data-limit"));
    var pager = el.getAttribute("data-pager");
    var page = pager === "pages" ? pageNumber(el) : 1;
    var q = {
      limit: limit, sort: sortOf(el), filter: el.getAttribute("data-filter") || "", expand: expandsOf(tpls.item),
      offset: pager === "pages" || pager === "more" ? (page - 1) * limit : null,
    };
    return Promise.resolve()
      .then(function () { return getJson(listUrl(collection, q), collection); })
      .then(function (body) {
        if (!body || !Array.isArray(body.items)) throw new Error("unexpected response for " + collection);
        // A newer render of the same element supersedes this one.
        if (latest.get(el) !== token) return;
        body.items.forEach(trust);
        if (body.items.length) renderList(el, body.items);
        else renderEmpty(el);
        var total = typeof body.total === "number" ? body.total : body.items.length;
        if (pager === "pages") {
          var pages = Math.ceil(total / limit);
          if (pages > 1 && tpls.pager) renderPagesTemplate(el, tpls.pager, page, pages, total);
          else if (pages > 1) renderPager(el, page, pages);
        } else if (pager === "more" && body.items.length) {
          moreState.set(el, {
            collection: collection, limit: limit, sort: q.sort, filter: q.filter, expand: q.expand,
            offset: body.items.length, total: total, loading: false,
          });
          renderMoreButton(el);
        }
      })
      .catch(function (err) { renderError(el, token, err); });
  }

  function renderEntryElement(el) {
    var token = {};
    latest.set(el, token);
    var collection = el.getAttribute("data-femtocms-entry");
    if (!collection) return Promise.resolve();
    var tpls = templatesOf(el);
    var key = entryKey(el);
    var expand = expandsOf(tpls.item);
    var url = key ? entryUrl(collection, key, expand) : singleUrl(collection, expand);
    return Promise.resolve()
      .then(function () { return getJson(url, key ? collection + "/" + key : collection, true); })
      .then(function (body) {
        if (latest.get(el) !== token) return;
        if (body === null || (!key && body && Array.isArray(body.items))) {
          setDocumentTitle(el, null);
          return renderEmpty(el);
        }
        if (!body || typeof body !== "object" || !body.data) throw new Error("unexpected response for " + collection + (key ? "/" + key : ""));
        renderEntry(el, trust(body));
        return renderPrevNext(el, collection, body, token);
      })
      .catch(function (err) { renderError(el, token, err); });
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
