import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Minimal fake WordPress REST API with one page, Basic auth and a registered meta key. */
export function fakeWordPress() {
  let origin = "";
  const page = { id: 5, slug: "about", title: "About", content: "<p>Hello <a href=\"/x\">x</a></p>", meta: { _seo_desc: "old description" } as Record<string, string> };
  const writes: unknown[] = [];
  const auth = `Basic ${Buffer.from("editor:app pass").toString("base64")}`;
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== auth) return send(401, { code: "rest_not_logged_in", message: "Sorry, you are not allowed to do that." });
    const url = new URL(req.url!, origin);
    const view = () => ({ id: page.id, slug: page.slug, link: `${origin}/about/`, modified: new Date().toISOString(), title: { raw: page.title, rendered: page.title }, content: { raw: page.content, rendered: page.content }, meta: page.meta });
    if (url.pathname === "/wp-json/wp/v2/users/me") return send(200, { id: 2, name: "Editor", roles: ["editor"], capabilities: { edit_posts: true } });
    if (url.pathname === "/wp-json/wp/v2/pages" && req.method === "GET") return send(200, url.searchParams.get("slug") === "about" ? [view()] : []);
    if (url.pathname === "/wp-json/wp/v2/posts" && req.method === "GET") return send(200, []);
    if (url.pathname === `/wp-json/wp/v2/pages/${page.id}`) {
      if (req.method === "GET") return send(200, view());
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body);
        writes.push(b);
        if (b.title !== undefined) page.title = b.title;
        if (b.content !== undefined) page.content = b.content;
        // Only registered (show_in_rest) meta keys are accepted, like real WordPress.
        if (b.meta) for (const [k, v] of Object.entries(b.meta)) if (k === "_seo_desc") page.meta[k] = String(v);
        send(200, view());
      });
      return;
    }
    send(404, { code: "rest_no_route" });
  });
  return {
    page, writes,
    get origin() { return origin; },
    start: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(origin); })),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
