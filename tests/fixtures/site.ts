import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A small website with deliberate SEO problems, served on 127.0.0.1. Mutable so tests can "fix" pages. */
export function fixtureSite() {
  let origin = "";
  const state = { fixed: false, robotsHits: 0, requests: [] as string[] };
  const page = (o: { title?: string | null; desc?: string; body: string; head?: string; lang?: boolean }) => `<!doctype html>
<html${o.lang === false ? "" : ' lang="en"'}><head>${o.title === null ? "" : `<title>${o.title ?? "Untitled"}</title>`}
<meta name="viewport" content="width=device-width, initial-scale=1">
${o.desc ? `<meta name="description" content="${o.desc}">` : ""}${o.head ?? ""}</head><body><main>${o.body}</main></body></html>`;
  const para = (n: number) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} about industrial widget maintenance schedules, safety checks, lubrication intervals and supplier selection for small manufacturing teams.</p>`).join("");

  const routes: Record<string, () => { status?: number; headers?: Record<string, string>; body?: string }> = {
    "/robots.txt": () => { state.robotsHits++; return { headers: { "content-type": "text/plain" }, body: `User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n` }; },
    "/sitemap.xml": () => ({ headers: { "content-type": "application/xml" }, body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/about", "/services", "/noindexed", "/orphan", "/old-page", "/private/secret"].map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>` }),
    "/": () => ({ body: page({ title: "Acme Widgets — Industrial widget maintenance", desc: "Acme helps small manufacturers keep widgets running with maintenance plans, inspections and certified parts.", head: `<link rel="canonical" href="${origin}/">`, body: `<h1>Acme Widgets</h1>${para(6)}<a href="/about">About us</a> <a href="/services">Services</a> <a href="/missing">Old link</a> <a href="/old-page">Legacy</a> <a href="/private/secret">Secret</a> <a href="/es/">Español</a> <a href="/thin">Thin</a><img src="/img/hero.jpg"><img src="/img/broken.png" alt="Broken" width="10" height="10">` }) }),
    "/about": () => ({ body: page({ title: "About", desc: state.fixed ? "About Acme Widgets: our story, certified technicians and the industries we serve across the region." : undefined, head: `<link rel="canonical" href="${origin}/about">`, body: `<h1>About</h1><h3>History</h3>${para(5)}<a href="/">Home</a>` }) }),
    "/services": () => ({ body: page({ title: "About", desc: "Services offered by Acme: maintenance plans, inspections, repairs and certified replacement parts.", head: `<link rel="canonical" href="${origin}/services"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","description":"x"}</script>`, body: `<h1>Services</h1>${para(5)}<a href="/">Home</a>` }) }),
    "/noindexed": () => ({ body: page({ title: "Hidden page in sitemap", desc: "This page is intentionally hidden from search engines but still listed in the XML sitemap by mistake.", head: '<meta name="robots" content="noindex">', body: `<h1>Hidden</h1>${para(4)}` }) }),
    "/orphan": () => ({ body: page({ title: "Orphan page nobody links to", desc: "An orphaned landing page that appears only in the XML sitemap and receives no internal links at all.", head: `<link rel="canonical" href="${origin}/orphan">`, body: `<h1>Orphan</h1>${para(5)}` }) }),
    "/thin": () => ({ body: page({ title: null, body: "<h1>Thin</h1><p>Short.</p><a href=\"/\">Home</a>" }) }),
    "/old-page": () => ({ status: 301, headers: { location: "/old-page-2" } }),
    "/old-page-2": () => ({ status: 301, headers: { location: "/services" } }),
    "/es/": () => ({ body: page({ title: "Acme Widgets en español — mantenimiento", desc: "Acme ayuda a pequeños fabricantes a mantener sus equipos funcionando con planes de mantenimiento.", head: `<link rel="canonical" href="${origin}/es/"><link rel="alternate" hreflang="es" href="${origin}/es/"><link rel="alternate" hreflang="en" href="${origin}/">`, body: `<h1>Acme</h1>${para(5)}` }) }),
    "/img/hero.jpg": () => ({ headers: { "content-type": "image/jpeg" }, body: "x".repeat(400 * 1024) }),
    "/private/secret": () => ({ body: page({ title: "Secret", body: "<h1>Should never be fetched</h1>" }) }),
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    state.requests.push(path);
    if (state.fixed && path === "/missing") { res.writeHead(301, { location: "/" }); return res.end(); }
    const r = routes[path]?.();
    if (!r) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<h1>Not found</h1>"); }
    res.writeHead(r.status ?? 200, { "content-type": "text/html; charset=utf-8", ...(r.headers ?? {}) });
    res.end(req.method === "HEAD" ? undefined : r.body);
  });

  return {
    state,
    get origin() { return origin; },
    start: (port = 0) => new Promise<string>((resolve) => server.listen(port, "127.0.0.1", () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(origin); })),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
