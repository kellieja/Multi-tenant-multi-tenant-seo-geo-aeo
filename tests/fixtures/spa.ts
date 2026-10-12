import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A client-rendered single-page app, like a typical React/Vite site built on Replit: every
 * route returns the same empty shell, and app.js builds the title, headings, text and links.
 * The script also tries a WebSocket, which the renderer must block.
 */
export function spaSite() {
  let origin = "";
  const shell = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><script type="module" src="/app.js"></script></head><body><div id="root"></div></body></html>`;
  const app = `
const routes = {
  "/": { title: "Acme Widgets — repair and maintenance", h1: "Industrial widget repair", body: "Acme repairs industrial widgets for small manufacturers. Our technicians handle bearings, seals and lubrication schedules so production lines keep running without surprise downtime. Book an inspection and get a written maintenance plan for every widget on your floor." },
  "/pricing": { title: "Widget repair pricing | Acme", h1: "Pricing", body: "Every repair starts with an inspection. We quote a fixed price before any work begins, and maintenance plans are billed monthly with no long contract. Parts are priced separately and listed on the quote so there are no surprises later." },
  "/about": { title: "About Acme Widgets", h1: "About us", body: "We have repaired widgets for manufacturers for many years. The team is small, certified and works on site, which keeps repairs quick and lines running. Read about our approach to preventive maintenance and how we schedule visits around your shifts." },
};
const r = routes[location.pathname] || { title: "Not found", h1: "Not found", body: "This page does not exist." };
document.title = r.title;
const root = document.getElementById("root");
root.innerHTML = '<main><h1></h1><p></p><nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/about">About</a></nav></main>';
root.querySelector("h1").textContent = r.h1;
root.querySelector("p").textContent = r.body;
try { new WebSocket("ws://" + location.host + "/live"); } catch (e) {}
`;
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nAllow: /\n"); }
    if (path === "/app.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(app); }
    if (["/", "/pricing", "/about"].includes(path)) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(shell); }
    res.writeHead(404, { "content-type": "text/html" }); res.end(shell);
  });
  return {
    get origin() { return origin; },
    start: () => new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok(origin); })),
    stop: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
