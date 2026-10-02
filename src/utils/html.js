// Small HTML helpers: escape plain text for interpolation into HTML, and an
// allowlist sanitizer for the holder `instruction` rich text.

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);

const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "strike", "ul", "ol", "li", "a", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "code", "pre", "sub", "sup",
  "table", "thead", "tbody", "tr", "td", "th",
]);
const VOID_TAGS = new Set(["br", "hr"]);
const DROP_WITH_CONTENT =
  /<(script|style|iframe|frame|frameset|object|embed|noscript|template|svg|math|title|head|textarea|select|button)\b[\s\S]*?<\/\1\s*>/gi;
const ALLOWED_STYLE_PROPS = new Set([
  "color", "background-color", "text-align", "font-weight", "font-style", "text-decoration",
]);

const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const escapeAttr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function safeHref(value) {
  // Anything beyond a plain &amp; entity could hide a scheme (jav&#x09;ascript:)
  const v = String(value).replace(/&amp;/gi, "&");
  if (/&#|&[a-z0-9]+;/i.test(v)) return null;
  const stripped = v.replace(/[\u0000- \u007f-\u009f]/g, "");
  if (/^[a-z][a-z0-9+.\-]*:/i.test(stripped)) {
    return /^(https?|mailto|tel):/i.test(stripped) ? v.trim() : null;
  }
  return v.trim();
}

function safeStyle(value) {
  const out = [];
  for (const decl of String(value).split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    if (!/^[#\w\s.,()%-]+$/.test(val) || /url\s*\(|expression|javascript/i.test(val)) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(";");
}

function buildTag(name, rawAttrs) {
  const attrs = [];
  let isBlankLink = false;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(rawAttrs))) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    if (name === "a" && key === "href") {
      const href = safeHref(val);
      if (href !== null) attrs.push(` href="${escapeAttr(href)}"`);
    } else if (name === "a" && key === "target" && val === "_blank") {
      isBlankLink = true;
    } else if (key === "style") {
      const style = safeStyle(val);
      if (style) attrs.push(` style="${escapeAttr(style)}"`);
    }
  }
  if (name === "a" && isBlankLink) attrs.push(' target="_blank" rel="noopener noreferrer"');
  return `<${name}${attrs.join("")}>`;
}

// Escape text between tags; keep already-valid entities (&amp; &nbsp; &#39;)
const escapeText = (s) =>
  s.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function sanitizeHtml(input) {
  if (input === undefined || input === null) return "";
  let html = String(input).replace(/<!--[\s\S]*?-->/g, "").replace(DROP_WITH_CONTENT, "");
  let out = "";
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    out += escapeText(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      if (!VOID_TAGS.has(name)) out += `</${name}>`;
    } else {
      out += buildTag(name, m[3] || "");
    }
  }
  out += escapeText(html.slice(last));
  return out.trim();
}

module.exports = { escapeHtml, sanitizeHtml };
