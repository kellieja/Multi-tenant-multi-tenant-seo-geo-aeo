import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A tiny "external web" of pages that link (or used to link) to a target site. */
export function fakeWeb(targetOrigin: () => string) {
  let origin = "";
  const state = { linkRemoved: false };
  const html = (body: string, title = "Page") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const routes: Record<string, () => [number, string, Record<string, string>?]> = {
    "/robots.txt": () => [200, "User-agent: *\nDisallow: /private\n", { "content-type": "text/plain" }],
    "/links-page": () => [200, html(state.linkRemoved ? "<p>Widget maintenance resources</p>" : `<p>Great resources on widget maintenance:</p><a href="${targetOrigin()}/guide" rel="nofollow">Acme guide</a>`, "Widget resources")],
    "/gone": () => [404, html("not found")],
    "/private/page": () => [200, html(`<a href="${targetOrigin()}/">x</a>`)],
    "/resources": () => [200, html(`<h1>Useful widget maintenance tools</h1><p>Industrial widget maintenance, lubrication schedules, inspection checklists and safety guides.</p><a href="${origin.replace("127.0.0.1", "localhost")}/dead-tool">Old inspection tool</a><a href="mailto:editor@resources.example">Email the editor</a>`, "Widget maintenance resources")],
    "/mention": () => [200, html("<p>We bought our widgets from Acme Widgets and they were great.</p>", "Review")],
    "/dead-tool": () => [404, "gone"],
  };
  const server = createServer((req, res) => {
    const r = routes[(req.url ?? "/").split("?")[0]]?.() ?? [404, "nope"];
    res.writeHead(r[0], { "content-type": "text/html", ...(r[2] ?? {}) });
    res.end(req.method === "HEAD" ? undefined : r[1]);
  });
  return {
    state,
    get origin() { return origin; },
    start: () => new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok(origin); })),
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
