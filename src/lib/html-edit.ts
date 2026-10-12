/**
 * Minimal, string-level edits to an HTML document. Only the targeted element changes; the rest
 * of the file stays byte-for-byte identical, so the approval diff shows exactly the edit.
 */

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

/** Replaces the first <title> (or inserts one at the top of <head>). */
export function setTitle(html: string, title: string) {
  const t = escText(title.trim());
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) return html.replace(/(<title\b[^>]*>)[\s\S]*?(<\/title>)/i, (_m, a: string, b: string) => `${a}${t}${b}`);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n    <title>${t}</title>`);
  throw new Error("The file has no <head> element to add a title to");
}

/** Replaces the content of <meta name="description"> (or inserts one after <title>/<head>). */
export function setMetaDescription(html: string, description: string) {
  const d = escAttr(description.trim());
  const tagRe = /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/i;
  const tag = html.match(tagRe)?.[0];
  if (tag) {
    const updated = /\bcontent\s*=\s*(["'])[\s\S]*?\1/i.test(tag)
      ? tag.replace(/\bcontent\s*=\s*(["'])[\s\S]*?\1/i, `content="${d}"`)
      : tag.replace(/\s*\/?>$/, (end) => ` content="${d}"${end}`);
    return html.replace(tag, updated);
  }
  const meta = `<meta name="description" content="${d}">`;
  if (/<\/title>/i.test(html)) return html.replace(/<\/title>/i, (m) => `${m}\n    ${meta}`);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n    ${meta}`);
  throw new Error("The file has no <head> element to add a meta description to");
}
