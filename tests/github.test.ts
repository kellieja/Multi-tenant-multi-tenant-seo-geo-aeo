import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { createWebsite } from "@/server/websites";
import { connectWithCredentials } from "@/server/integrations";
import { decideApproval } from "@/server/approvals";
import { proposeSiteChange, processSiteChangeApply, rollbackSiteChange, syncGitHubPullRequests } from "@/server/site-changes";
import { proposeInternalLink, setLinkSuggestionStatus } from "@/server/internal-links";
import { replaceMetadata } from "@/server/github-edits";
import * as queue from "@/lib/jobs/queue";
import type { JobContext } from "@/lib/jobs/context";
import { fakeGitHub } from "./fixtures/github";
import { makeContext } from "./helpers";

const gh = fakeGitHub();
const PRICING_TSX = `import { useEffect } from "react";

export default function Pricing() {
  useEffect(() => { document.title = "Pricing | Acme"; }, []);
  return (
    <main>
      <h1>Pricing</h1>
      <p>Every repair starts with an inspection and a fixed quote.</p>
    </main>
  );
}
`;
const HOME_TSX = `export default function Home() {
  return (
    <main>
      <h1>Acme widget repair</h1>
      <p>
        We offer maintenance plans for every widget on your floor, with visits scheduled around your shifts.
      </p>
    </main>
  );
}
`;

beforeAll(async () => {
  process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
  await gh.start();
  process.env.GITHUB_API_URL = gh.origin;
  vi.spyOn(queue, "enqueueJob").mockResolvedValue({ job: { id: "q", status: "QUEUED" }, deduped: false } as never);
});
afterAll(async () => { await gh.stop(); delete process.env.GITHUB_API_URL; process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; vi.restoreAllMocks(); });
beforeEach(() => {
  gh.state.branches = new Map([["main", new Map([["index.html", "<!doctype html><html><head><title>Acme</title></head><body><div id=\"root\"></div></body></html>"], ["src/pages/Pricing.tsx", PRICING_TSX], ["src/pages/Home.tsx", HOME_TSX], ["node_modules/x/index.js", 'document.title = "Pricing | Acme";']])]]);
  gh.state.pulls = [];
  gh.state.push = true;
});
const jc = (job: object) => ({ job: { attempts: 1, status: "RUNNING", type: "site-change-apply", payload: {}, ...job }, progress: async () => undefined, isCancelled: async () => false, log: () => undefined }) as unknown as JobContext;

async function setup() {
  const owner = await makeContext();
  const site = await createWebsite(owner, { name: "Replit shop", url: `gh-shop-${Date.now()}.example.com` });
  await connectWithCredentials(owner, "GITHUB", { repository: gh.repo, token: gh.token }, site.id);
  const crawl = await prisma.crawl.create({ data: { organizationId: owner.org.id, websiteId: site.id, settings: {}, summary: {}, status: "SUCCEEDED", finishedAt: new Date() } });
  await prisma.crawledPage.create({ data: { organizationId: owner.org.id, crawlId: crawl.id, websiteId: site.id, url: `https://${site.domain}/pricing`, statusCode: 200, title: "Pricing | Acme", metaDescription: "Generated at runtime" } });
  const manager = await makeContext("MANAGER", { orgId: owner.org.id });
  return { owner, manager, site, crawl };
}

describe("source edits", () => {
  it("escapes replacements for the syntax around the match and refuses ambiguity", () => {
    const files = [{ path: "src/pages/Pricing.tsx", sha: "1", content: PRICING_TSX }];
    const e = replaceMetadata(files, "Pricing | Acme", 'Pricing "2026" | Acme', "title");
    expect(e.after).toContain('document.title = "Pricing \\"2026\\" | Acme";');
    const html = [{ path: "index.html", sha: "2", content: "<head><title>Acme &amp; Co</title><meta name=\"og:title\" content=\"x\"></head>" }];
    expect(replaceMetadata(html, "Acme & Co", "Acme <Widgets>", "title").after).toContain("<title>Acme &lt;Widgets&gt;</title>");
    const twice = [{ path: "a.tsx", sha: "3", content: 'const t = "Same"; document.title = "Same"; const u = { title: "Same" };' }];
    expect(() => replaceMetadata(twice, "Same", "New", "title")).toThrow(/2 places/);
  });
});

describe("GitHub connector", () => {
  it("opens an approved title change as a pull request, tracks the merge and reverts via a second PR", async () => {
    const { owner, manager, site } = await setup();
    const change = await proposeSiteChange(owner, { websiteId: site.id, url: `https://${site.domain}/pricing`, field: "title", value: "Widget repair pricing | Acme" });
    expect(change.connector).toBe("github");
    expect(change.targetRef).toMatch(/^gh:src\/pages\/Pricing\.tsx@[0-9a-f]{40}$/); // node_modules ignored
    expect(change.after).toContain('document.title = "Widget repair pricing | Acme";');
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: change.approvalId! } });
    expect(approval.summary).toMatch(/Open a pull request/);
    expect(gh.state.pulls).toHaveLength(0); // nothing opened before approval

    await decideApproval(manager, change.approvalId!, "APPROVED");
    await processSiteChangeApply(jc({ id: "a", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }));
    let row = await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } });
    expect(row.status).toBe("PR_OPEN");
    expect(row.externalUrl).toBe(`https://github.com/${gh.repo}/pull/1`);
    expect(gh.main().get("src/pages/Pricing.tsx")).toBe(PRICING_TSX); // main untouched until merged
    expect(gh.state.branches.get(gh.state.pulls[0].head)!.get("src/pages/Pricing.tsx")).toContain("Widget repair pricing | Acme");

    expect(await syncGitHubPullRequests()).toBe(0); // still open
    gh.merge(1);
    expect(await syncGitHubPullRequests()).toBe(1);
    row = await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } });
    expect(row.status).toBe("APPLIED");

    await rollbackSiteChange(manager, change.id);
    row = await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } });
    expect(row.status).toBe("REVERT_PR_OPEN");
    gh.merge(2);
    await syncGitHubPullRequests();
    expect((await prisma.siteChange.findUniqueOrThrow({ where: { id: change.id } })).status).toBe("ROLLED_BACK");
    expect(gh.main().get("src/pages/Pricing.tsx")).toBe(PRICING_TSX);
  });

  it("refuses stale files, explains dynamic metadata, and scans the repo when code search is unavailable", async () => {
    const { owner, manager, site } = await setup();
    await expect(proposeSiteChange(owner, { websiteId: site.id, url: `https://${site.domain}/pricing`, field: "meta_description", value: "New" })).rejects.toThrow(/built dynamically; use a change pack/);

    gh.state.searchWorks = false;
    const change = await proposeSiteChange(owner, { websiteId: site.id, url: `https://${site.domain}/pricing`, field: "title", value: "Repair prices | Acme" });
    gh.state.searchWorks = true;
    expect(change.targetRef).toContain("src/pages/Pricing.tsx");
    gh.main().set("src/pages/Pricing.tsx", PRICING_TSX.replace("fixed quote", "fixed, written quote")); // someone edits main
    await decideApproval(manager, change.approvalId!, "APPROVED");
    await expect(processSiteChangeApply(jc({ id: "b", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: change.id } }))).rejects.toThrow(/changed after this change was proposed/);
    expect(gh.state.pulls).toHaveLength(0);

    // A closed (unmerged) PR marks the change rejected.
    gh.main().set("src/pages/Pricing.tsx", PRICING_TSX);
    const again = await proposeSiteChange(owner, { websiteId: site.id, url: `https://${site.domain}/pricing`, field: "title", value: "Prices | Acme" });
    await decideApproval(manager, again.approvalId!, "APPROVED");
    await processSiteChangeApply(jc({ id: "c", organizationId: owner.org.id, websiteId: site.id, payload: { siteChangeId: again.id } }));
    gh.close(1);
    await syncGitHubPullRequests();
    expect((await prisma.siteChange.findUniqueOrThrow({ where: { id: again.id } })).status).toBe("REJECTED");
  });

  it("adds an internal link inside JSX paragraph text with a relative href", async () => {
    const { owner, site, crawl } = await setup();
    const sug = await prisma.internalLinkSuggestion.create({ data: { organizationId: owner.org.id, websiteId: site.id, crawlId: crawl.id, sourceUrl: `https://${site.domain}/`, targetUrl: `https://${site.domain}/pricing`, anchor: "maintenance plans", sourceParagraph: "We offer maintenance plans for every widget on your floor, with visits scheduled around your shifts.", rationale: "t", score: 70 } });
    await setLinkSuggestionStatus(owner, sug.id, "APPROVED");
    const change = await proposeInternalLink(owner, sug.id);
    expect(change.targetRef).toContain("src/pages/Home.tsx");
    expect(change.after).toContain('We offer <a href="/pricing">maintenance plans</a> for every widget');
  });

  it("requires a token that can push", async () => {
    const owner = await makeContext();
    const site = await createWebsite(owner, { name: "RO", url: `gh-ro-${Date.now()}.example.com` });
    gh.state.push = false;
    await expect(connectWithCredentials(owner, "GITHUB", { repository: gh.repo, token: gh.token }, site.id)).rejects.toThrow(/can't write/);
    gh.state.push = true;
    await expect(connectWithCredentials(owner, "GITHUB", { repository: gh.repo, token: "wrong" }, site.id)).rejects.toThrow(/rejected the token/);
    await expect(connectWithCredentials(owner, "GITHUB", { repository: "not a repo", token: gh.token }, site.id)).rejects.toThrow(/owner\/name/);
  });
});
