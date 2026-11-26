import { Marked } from "marked";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** Returns the URL ready to put in an attribute, or null when it could run script (javascript:, data:, ...). */
function safeUrl(href: string): string | null {
  // Browsers ignore whitespace/control characters inside a scheme ("java\tscript:"), so test without them.
  const probe = href.replace(/[\u0000- \u007f-\u009f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1].toLowerCase();
  if (scheme !== undefined && !SAFE_SCHEMES.has(scheme)) return null;
  try {
    // Escaping `&` stops entities such as "&colon;" from turning into a live scheme in the browser.
    return escapeHtml(encodeURI(href).replace(/%25/g, "%"));
  } catch {
    return null;
  }
}

const title = (t: string | null | undefined) => (t ? ` title="${escapeHtml(t)}"` : "");

// Output is meant for LPs and preview pages, so it must never carry live raw HTML or script URLs.
const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    // Raw HTML (block and inline) is shown as text.
    html: ({ text }) => escapeHtml(text),
    link(token) {
      const href = safeUrl(token.href);
      const inner = this.parser.parseInline(token.tokens);
      return href === null ? inner : `<a href="${href}"${title(token.title)}>${inner}</a>`;
    },
    image(token) {
      const src = safeUrl(token.href);
      return src === null ? escapeHtml(token.text) : `<img src="${src}" alt="${escapeHtml(token.text)}"${title(token.title)}>`;
    },
  },
});

export function renderMarkdown(md: string): string {
  return marked.parse(md) as string;
}
