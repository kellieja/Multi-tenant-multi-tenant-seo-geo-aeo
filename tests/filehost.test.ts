import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { setMetaDescription, setTitle } from "@/lib/html-edit";
import { candidateFiles, underRoot, looksLikeSpaShell, FileHostClient } from "@/integrations/filehost";
import { createWebsite } from "@/server/websites";
import { connectWithCredentials, retestConnection } from "@/server/integrations";
import { decideApproval } from "@/server/approvals";
import { proposeSiteChange, processSiteChangeApply, rollbackSiteChange } from "@/server/site-changes";
import { proposeInternalLink, setLinkSuggestionStatus } from "@/server/internal-links";
import * as queue from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { fakeSftp } from "./fixtures/sftp";
import { makeContext } from "./helpers";

const sftp = fakeSftp();
const PRICING = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pricing</title>
  <meta name="viewport" content="width=device-width">
</head>
<body><main><h1>Pricing</h1><p>Every repair starts with an inspection and a fixed written quote.</p></main></body>
</html>
`;
const HOME = `<!doctype html><html><head><title>Acme</title></head><body><main><p>We repair widgets. See our repair pricing before you book an inspection.</p></main></body></html>`;

beforeAll(async () => {
  process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
  await sftp.start();
  vi.spyOn(queue, "enqueueJob").mockResolvedValue({ job: { id: "q", status: "QUEUED" }, deduped: false } as never);
});
afterAll(async () => { await sftp.stop(); process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; vi.restoreAllMocks(); });
const jc = (job: object) => ({ job: { attempts: 1, status: "RUNNING", type: "site-change-apply", payload: {}, ...job }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;
const creds = () => ({ protocol: "sftp", host: "127.0.0.1", port: String(sftp.port), username: sftp.username, password: sftp.password, docRoot: "/public_html" });

describe("HTML edits", () => {
  it("changes only the title or meta description and leaves the rest byte-for-byte", () => {
    const t = setTitle(PRICING, "Widget repair pricing | Acme & Co");
    expect(t).toBe(PRICING.replace("<title>Pricing</title>", "<title>Widget repair pricing | Acme &amp; Co</title>"));
    const m = setMetaDescription(PRICING, 'Fixed-price "repairs"');
    expect(m).toBe(PRICING.replace("</title>", '</title>\n    <meta name="description" content="Fixed-price &quot;repairs&quot;">'));
    const m2 = setMetaDescription(m, "Second version");
    expect(m2).toContain('<meta name="description" content="Second version">');
    expect(m2.match(/name="description"/g)).toHaveLength(1);
    expect(setTitle("<html><head></head><body></body></html>", "New")).toContain("<head>\n    <title>New</title>");
  });

  it("maps URLs to files without escaping the document root", () => {
    expect(candidateFiles("/")).toEqual(["/index.html", "/index.htm"]);
    expect(candidateFiles("/pricing")).toEqual(["/pricing.html", "/pricing/index.html", "/pricing.htm", "/pricing/index.htm"]);
    expect(underRoot("/public_html", "/blog/index.html")).toBe("/public_html/blog/index.html");
    expect(() => underRoot("/public_html", "/../etc/passwd")).toThrow(/escapes/);
    expect(() => underRoot("/public_html", "/%2e%2e/x")).not.toThrow(); // stays literal under the root
    expect(looksLikeSpaShell('<html><head><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>')).toBe(true);
    expect(looksLikeSpaShell(PRICING)).toBe(false);
  });

  it("refuses plain FTP and private hosts", async () => {
    await expect(FileHostClient.open({ ...creds(), protocol: "ftp" })).rejects.toThrow(/unencrypted/);
    await expect(FileHostClient.open(creds(), {}, { allowPrivate: false })).rejects.toThrow(/public host/);
  });
});

describe("File host connector (SFTP)", () => {
  it("connects with a pinned host key, then proposes, applies, verifies and rolls back a title change", async () => {
    sftp.files.clear();
    sftp.files.set("/public_html/index.html", Buffer.from(HOME));
    sftp.files.set("/public_html/pricing.html", Buffer.from(PRICING));
    const owner = await makeContext();
    const site = await createWebsite(owner, { name: "Static shop", url: `static-${Date.now()}.example.com` });
    const { connectionId } = await connectWithCredentials(owner, "FILE_HOST", creds(), site.id);
    const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect((conn.config as { hostKeySha256?: string }).hostKeySha256).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(JSON.stringify(conn.config)).not.toContain(sftp.password);
    expect(conn.encryptedSecret).not.toContain(sftp.password);

    const change = await proposeSiteChange(owner, { websiteId: site.id, url: `https://${site.domain}/pricing`, field: "title", value: "Widget repair pricing | Acme" });
    expect(change).toMatchObject({ connector: "filehost", targetRef: "file:/public_html/pricing.html", field: "file", status: "PENDING_APPROVAL" });
    expect(change.before).toBe(PRICING);
    expect(change.after).toBe(PRICING.replace("<title>Pricing</title>", "<title>Widget repair pricing | Acme</title>"));
    expect(sftp.files.get("/public_html/pricing.html")!.toString()).toBe(PRICING); // nothing written before approval

    const manager = await makeContext("MANAGER", { orgId: owner.org.id });
    await decideApproval(manager, change.approvalId!, "APPROVED");
    await processSiteChangeApply(jc({ id: "a", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }));
    expect(sftp.files.get("/public_html/pricing.html")!.toString()).toContain("<title>Widget repair pricing | Acme</title>");
    expect([...sftp.files.keys()].some((k) => k.includes("searchops-tmp"))).toBe(false);
    expect((await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } })).status).toBe("APPLIED");

    await rollbackSiteChange(manager, change.id);
    expect(sftp.files.get("/public_html/pricing.html")!.toString()).toBe(PRICING);
  });

  it("refuses to overwrite a file edited after the proposal, and inserts internal links", async () => {
    sftp.files.clear();
    sftp.files.set("/public_html/index.html", Buffer.from(HOME));
    sftp.files.set("/public_html/pricing.html", Buffer.from(PRICING));
    const owner = await makeContext();
    const site = await createWebsite(owner, { name: "Static shop 2", url: `static2-${Date.now()}.example.com` });
    await connectWithCredentials(owner, "FILE_HOST", creds(), site.id);
    const manager = await makeContext("MANAGER", { orgId: owner.org.id });

    const meta = await proposeSiteChange(owner, { websiteId: site.id, url: `https://${site.domain}/pricing`, field: "meta_description", value: "Fixed-price widget repairs." });
    await decideApproval(manager, meta.approvalId!, "APPROVED");
    sftp.files.set("/public_html/pricing.html", Buffer.from(PRICING.replace("fixed written quote", "fixed, written quote")));
    await expect(processSiteChangeApply(jc({ id: "b", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: meta.id } }))).rejects.toThrow(/changed after this change was proposed/);
    expect(sftp.files.get("/public_html/pricing.html")!.toString()).toContain("fixed, written quote");

    const crawl = await prisma.crawl.create({ data: { organizationId: owner.org.id, websiteId: site.id, settings: {}, summary: {} } });
    const sug = await prisma.internalLinkSuggestion.create({ data: { organizationId: owner.org.id, websiteId: site.id, crawlId: crawl.id, sourceUrl: `https://${site.domain}/`, targetUrl: `https://${site.domain}/pricing`, anchor: "repair pricing", sourceParagraph: "See our repair pricing before you book an inspection.", rationale: "t", score: 60 } });
    await setLinkSuggestionStatus(owner, sug.id, "APPROVED");
    const link = await proposeInternalLink(owner, sug.id);
    expect(link.after).toContain(`<a href="https://${site.domain}/pricing">repair pricing</a>`);
    await decideApproval(manager, link.approvalId!, "APPROVED");
    await processSiteChangeApply(jc({ id: "c", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: link.id } }));
    expect(sftp.files.get("/public_html/index.html")!.toString()).toContain(`<a href="https://${site.domain}/pricing">repair pricing</a>`);
    expect((await prisma.internalLinkSuggestion.findUniqueOrThrow({ where: { id: sug.id } })).status).toBe("APPLIED");
  });

  it("explains single-page apps and refuses a changed host key", async () => {
    sftp.files.clear();
    sftp.files.set("/public_html/index.html", Buffer.from('<!doctype html><html><head><title>App</title><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>'));
    const owner = await makeContext();
    const site = await createWebsite(owner, { name: "Replit SPA", url: `spa-${Date.now()}.example.com` });
    const { connectionId } = await connectWithCredentials(owner, "FILE_HOST", creds(), site.id);
    await expect(proposeSiteChange(owner, { websiteId: site.id, url: `https://${site.domain}/about`, field: "title", value: "About us" })).rejects.toThrow(/single-page app.*change pack/);

    await sftp.rotateHostKey();
    await expect(retestConnection(owner, connectionId)).rejects.toThrow(/host key changed/);
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe("ERROR");
  });
});
