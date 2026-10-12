import { UserError } from "@/lib/errors";
import { GitHubClient, SKIP_DIR, SOURCE_FILE } from "@/integrations/github";
import { insertLink } from "./internal-links";

export interface SourceFile { path: string; content: string; sha: string }

const MAX_SCAN = 400;
const MAX_SIZE = 300 * 1024;
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inSitePath = (path: string, sitePath?: string) => {
  const root = (sitePath ?? "").replace(/^\/+|\/+$/g, "");
  return !root || path === root || path.startsWith(`${root}/`);
};

/**
 * Source files on `ref` that contain any of the needles. Uses GitHub code search when the ref is
 * the default branch, and falls back to scanning the repository tree (bounded) otherwise.
 */
export async function findInRepo(gh: GitHubClient, ref: string, needles: string[], opts: { sitePath?: string; isDefaultBranch: boolean }): Promise<SourceFile[]> {
  const wanted = (p: string) => SOURCE_FILE.test(p) && !SKIP_DIR.test(p) && inSitePath(p, opts.sitePath);
  const contains = (c: string) => needles.some((n) => n && c.includes(n));
  const fetchAll = async (paths: string[]) => {
    const out: SourceFile[] = [];
    for (let i = 0; i < paths.length; i += 6) {
      const batch = await Promise.all(paths.slice(i, i + 6).map(async (p) => { const f = await gh.file(p, ref); return f ? { path: p, ...f } : null; }));
      for (const f of batch) if (f && contains(f.content)) out.push(f);
    }
    return out;
  };
  if (opts.isDefaultBranch) {
    const hits = new Set<string>();
    for (const n of needles.filter(Boolean)) for (const p of (await gh.searchCode(n)) ?? []) if (wanted(p)) hits.add(p);
    if (hits.size) {
      const found = await fetchAll([...hits]);
      if (found.length) return found;
    }
  }
  const tree = await gh.tree(await gh.branchSha(ref));
  const paths = tree.tree.filter((t) => t.type === "blob" && wanted(t.path) && (t.size ?? 0) <= MAX_SIZE).map((t) => t.path).slice(0, MAX_SCAN);
  return fetchAll(paths);
}

/** Escapes a replacement for the syntax around an occurrence: a JS/TS string literal, JSX/HTML text, or plain text. */
function escapeFor(content: string, index: number, length: number, value: string, path: string) {
  const before = content[index - 1];
  const after = content[index + length];
  if ((before === '"' || before === "'" || before === "`") && after === before) {
    if (/\.(html?|vue|svelte|astro|php|ejs|hbs|njk|liquid)$/i.test(path) && before !== "`" && !/[=:(,[]\s*$/.test(content.slice(Math.max(0, index - 20), index - 1))) {
      return escHtml(value); // an HTML attribute value
    }
    let v = value.replace(/\\/g, "\\\\").split(before).join(`\\${before}`);
    if (before === "`") v = v.replace(/\$\{/g, "\\${");
    return v;
  }
  if (/\.mdx?$/i.test(path)) return value;
  if (/\.json$/i.test(path)) return JSON.stringify(value).slice(1, -1);
  // HTML or JSX text content.
  const v = escHtml(value);
  return /\.(jsx|tsx|js|ts|mjs)$/i.test(path) ? v.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;") : v;
}

export interface SourceEdit { path: string; sha: string; before: string; after: string }

/**
 * Replaces the page's current title or meta description text in the source. Occurrences whose
 * surroundings mention title/description win; anything still ambiguous is refused.
 */
export function replaceMetadata(files: SourceFile[], current: string, next: string, kind: "title" | "meta_description"): SourceEdit {
  const variants = [...new Set([current, escHtml(current)])];
  const hint = kind === "title" ? /title/i : /description/i;
  const hits: { file: SourceFile; index: number; length: number; score: number }[] = [];
  for (const f of files) {
    for (const v of variants) {
      let i = f.content.indexOf(v);
      while (i !== -1) {
        const ctx = f.content.slice(Math.max(0, i - 120), i);
        hits.push({ file: f, index: i, length: v.length, score: hint.test(ctx) ? 1 : 0 });
        i = f.content.indexOf(v, i + v.length);
      }
    }
  }
  if (!hits.length) throw new UserError(`Couldn't find the current ${kind === "title" ? "title" : "meta description"} (“${current.slice(0, 80)}”) in the repository. It may be built dynamically; use a change pack so the developer or Replit Agent can change it in code.`);
  const best = Math.max(...hits.map((h) => h.score));
  const top = hits.filter((h) => h.score === best);
  if (top.length > 1) throw new UserError(`The current ${kind === "title" ? "title" : "meta description"} appears in ${top.length} places (${[...new Set(top.map((t) => t.file.path))].slice(0, 4).join(", ")}). Use a change pack so the right one is edited.`);
  const h = top[0];
  const replacement = escapeFor(h.file.content, h.index, h.length, next, h.file.path);
  return { path: h.file.path, sha: h.file.sha, before: h.file.content, after: h.file.content.slice(0, h.index) + replacement + h.file.content.slice(h.index + h.length) };
}

/** Wraps the anchor in the paragraph that matches the crawled text. */
export function addLinkInSource(files: SourceFile[], anchor: string, href: string, paragraph: string): SourceEdit {
  const words = paragraph.split(/\s+/).filter(Boolean).slice(0, 6).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const lead = words.length ? new RegExp(words.join("[\\s\\S]{0,40}?"), "i") : null;
  const candidates = files.filter((f) => f.content.toLowerCase().includes(anchor.toLowerCase()));
  const matching = lead ? candidates.filter((f) => lead.test(f.content)) : candidates;
  const pool = matching.length ? matching : candidates;
  if (!pool.length) throw new UserError(`Couldn't find “${anchor}” in the repository's source files. Use a change pack instead.`);
  if (pool.length > 1) throw new UserError(`“${anchor}” appears in several files (${pool.slice(0, 4).map((f) => f.path).join(", ")}). Use a change pack so the right one is edited.`);
  const f = pool[0];
  let after: string | null;
  if (/\.mdx?$/i.test(f.path)) {
    const re = new RegExp(`(?<![\\[\\w])(${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\]\\w])`, "i");
    after = re.test(f.content) ? f.content.replace(re, `[$1](${href})`) : null;
  } else {
    after = insertLink(f.content, anchor, href);
  }
  if (!after) throw new UserError(`Found ${f.path}, but “${anchor}” isn't inside paragraph text there (it may be generated from data). Use a change pack instead.`);
  return { path: f.path, sha: f.sha, before: f.content, after };
}

/** Path part of a URL, used for links inside source code (works with client-side routers too). */
export const relativeHref = (url: string) => { try { const u = new URL(url); return `${u.pathname}${u.search}${u.hash}` || "/"; } catch { return url; } };

export const branchNameFor = (changeId: string) => `searchops/${changeId.slice(-10)}`;
