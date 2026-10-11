import { test, expect } from "@playwright/test";

const shots = process.env.E2E_SCREENSHOTS;
const fixture = process.env.E2E_FIXTURE_URL ?? "http://127.0.0.1:4100";

test("content studio, internal linking, reports with approval, and the client portal", async ({ page, browser }) => {
  test.skip(!process.env.E2E_WITH_WORKER, "requires a running worker and fixture site");
  test.setTimeout(300_000);
  const stamp = Date.now();
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Robin Reports");
  await page.getByLabel("Work email").fill(`reports${stamp}@example.test`);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Workspace name").fill("Reporting Co");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/websites?welcome=1");

  // A client to own the website
  await page.goto("/settings?tab=clients");
  await page.getByLabel("Name", { exact: true }).fill("Acme Holdings");
  await page.getByRole("button", { name: "Create client" }).click();
  await expect(page.getByText("Acme Holdings").first()).toBeVisible({ timeout: 30_000 });

  await page.goto("/websites");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website URL").fill(fixture);
  await page.getByLabel("Display name").fill("Acme Widgets");
  await page.getByRole("dialog").getByLabel("Client").selectOption({ label: "Acme Holdings" });
  await page.getByRole("dialog").getByRole("button", { name: "Add website" }).click();
  await page.waitForURL(/\/websites\/[^/?]+/);
  await expect(page.getByText("No crawl yet").first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/50-website-hub.png`, fullPage: true });

  await page.goto("/audits");
  await page.getByRole("button", { name: "Run first crawl" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start crawl" }).click();
  await page.waitForURL(/\/audits\/[^/?]+$/);
  await expect(page.getByText("Before / after by issue type")).toBeVisible({ timeout: 90_000 });

  // Content Studio: analyze a live page, then compare with a "competitor" (same fixture via localhost)
  await page.goto("/content?tab=analyze");
  await page.getByLabel("Page URL").fill(`${fixture}/about`);
  await page.getByLabel("Target keyword (optional)").fill("widget maintenance");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("heading", { name: "Content checks" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Keyword: “widget maintenance”")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/51-content-analyze.png`, fullPage: true });
  await page.goto("/content?tab=compare");
  await page.getByLabel("Your page URL").fill(`${fixture}/about`);
  await page.getByLabel("Competitor page URL").fill(`${fixture.replace("127.0.0.1", "localhost")}/services`);
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.getByRole("heading", { name: "Topics the competitor covers" })).toBeVisible({ timeout: 30_000 });
  if (shots) await page.screenshot({ path: `${shots}/52-content-compare.png`, fullPage: true });
  await page.goto("/content?tab=briefs");
  await expect(page.getByText("Connect an AI provider")).toBeVisible();

  // Internal linking: run analysis via the worker
  await page.goto("/internal-links");
  await page.getByRole("button", { name: "Find link opportunities" }).click();
  await expect(page.getByText(/Link analysis queued/)).toBeVisible();
  await expect.poll(async () => {
    await page.goto("/internal-links");
    return page.getByText(/Last run .* succeeded/).count();
  }, { timeout: 60_000 }).toBe(1);
  if (shots) await page.screenshot({ path: `${shots}/53-internal-links.png`, fullPage: true });
  await page.goto("/internal-links?tab=graph");
  await expect(page.getByRole("heading", { name: "Pages that need more internal links" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/54-link-graph.png`, fullPage: true });

  // Reports: generate, review, approve, download
  await page.goto("/reports");
  await page.getByRole("button", { name: "New report" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Title").fill("October report");
  await dlg.getByLabel("Commentary (optional)").fill("First crawl completed; fixing broken links next.");
  await dlg.getByRole("button", { name: "Generate" }).click();
  await page.waitForURL(/\/reports\/[^/?]+$/);
  const reportUrl = page.url();
  await expect(page.getByText("awaiting approval").first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/55-report-review.png`, fullPage: true });
  const pdf = await page.request.get(`${reportUrl.replace("/reports/", "/api/reports/")}/pdf`);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  const dash = await page.request.get("/api/export/dashboard-pdf?range=28d");
  expect(dash.status()).toBe(200);

  // Client portal: invite a client user before approval; they see nothing until it's approved
  await page.goto("/settings?tab=members");
  await page.getByLabel("Email", { exact: true }).fill(`client${stamp}@example.test`);
  await page.getByLabel("Role").selectOption("CLIENT");
  await page.getByLabel("Client", { exact: true }).selectOption({ label: "Acme Holdings" });
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = await page.locator("input[readonly]").inputValue();
  expect(link).toContain("/invite/");

  const clientCtx = await browser.newContext();
  const cp = await clientCtx.newPage();
  await cp.goto(link);
  await cp.waitForURL(/\/register/);
  await cp.getByLabel("Full name").fill("Casey Client");
  await cp.getByLabel("Work email").fill(`client${stamp}@example.test`);
  await cp.getByLabel("Password").fill("correct-horse-42");
  await cp.getByRole("button", { name: "Create account" }).click();
  await cp.waitForURL(/\/invite\//);
  await cp.getByRole("button", { name: "Accept invitation" }).click();
  await cp.waitForURL(/\/dashboard/);
  await cp.goto("/reports");
  await expect(cp.getByText("No reports shared yet")).toBeVisible();
  expect((await cp.request.get(`${reportUrl.replace("/reports/", "/api/reports/")}/pdf`)).status()).toBe(404);
  await expect(cp.getByRole("link", { name: "Content Studio" })).toHaveCount(0);

  await page.goto(reportUrl);
  await page.getByRole("button", { name: "Approve for client" }).click();
  await expect(page.getByText(/^approved /)).toBeVisible();

  await cp.goto("/reports");
  await cp.getByRole("link", { name: "October report" }).click();
  await expect(cp.getByText("First crawl completed; fixing broken links next.")).toBeVisible();
  await expect(cp.getByRole("button", { name: "Approve for client" })).toHaveCount(0);
  if (shots) await cp.screenshot({ path: `${shots}/56-client-report.png`, fullPage: true });
  await clientCtx.close();
});
