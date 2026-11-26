/* femtocms embed: renders a list into every [data-femtocms] element and one entry into every [data-femtocms-entry] element. No dependencies. */
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

  function buildUrl(collection, limit) {
    var url = new URL(base + "/api/" + encodeURIComponent(collection));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "-publishedAt");
    return url.toString();
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

  function renderField(name, item, locale) {
    if (DATE_FIELDS[name] === 1) {
      var raw = item[name];
      var d = typeof raw === "string" ? new Date(raw) : null;
      if (!d || isNaN(d.getTime())) return null;
      var time = document.createElement("time");
      time.className = "fcms-date";
      time.setAttribute("datetime", raw);
      try {
        time.textContent = d.toLocaleDateString(locale || undefined);
      } catch (e) {
        time.textContent = d.toLocaleDateString();
      }
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
    if (value && typeof value === "object" && typeof value.url === "string" && /^https?:\/\//i.test(value.url)) {
      var img = document.createElement("img");
      img.className = "fcms-image";
      img.setAttribute("src", value.url);
      img.setAttribute("alt", typeof value.alt === "string" ? value.alt : "");
      img.setAttribute("loading", "lazy");
      return img;
    }
    return null;
  }

  function renderList(el, items) {
    var fields = (el.getAttribute("data-fields") || "publishedAt,title")
      .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var locale = el.getAttribute("data-locale") || document.documentElement.lang || "";
    var template = el.getAttribute("data-href") || "";
    var ul = document.createElement("ul");
    ul.className = "fcms-list";
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
    el.textContent = "";
    el.appendChild(ul);
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
    var locale = el.getAttribute("data-locale") || document.documentElement.lang || "";
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

  function buildEntryUrl(collection, key) {
    var url = new URL(base + "/api/" + encodeURIComponent(collection) + "/" + encodeURIComponent(key));
    var preview = new URLSearchParams(window.location.search).get("preview");
    if (preview) url.searchParams.set("preview", preview);
    return url.toString();
  }

  var latest = new WeakMap();

  function renderEntryElement(el) {
    var token = {};
    latest.set(el, token);
    var collection = el.getAttribute("data-femtocms-entry");
    if (!collection) return Promise.resolve();
    var key = entryKey(el);
    if (!key) {
      renderEmpty(el);
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(function () { return fetch(buildEntryUrl(collection, key), { credentials: "omit" }); })
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
    return fetch(buildUrl(collection, clampLimit(el.getAttribute("data-limit"))), { credentials: "omit" })
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

  window.femtocms = { refresh: refresh };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { refresh(); });
  else refresh();
})();
