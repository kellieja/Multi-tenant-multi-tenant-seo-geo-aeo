import { test, expect } from "@playwright/test";

const shots = process.env.E2E_SCREENSHOTS;
const fixture = process.env.E2E_FIXTURE_URL ?? "http://127.0.0.1:4100";

test("AEO assessment, schema validator, GEO prompt sets and entity audit", async ({ page }) => {
  test.skip(!process.env.E2E_WITH_WORKER, "requires a running worker and fixture site");
  test.setTimeout(240_000);
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Avery Answers");
  await page.getByLabel("Work email").fill(`aeo${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Workspace name").fill("Answers Co");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/websites?welcome=1");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website URL").fill(fixture);
  await page.getByLabel("Display name").fill("Acme Widgets");
  await page.getByRole("dialog").getByRole("button", { name: "Add website" }).click();
  await page.waitForURL(/\/websites\/[^/?]+/);

  // Crawl first: AEO page selection and entity checks read crawl data
  await page.goto("/audits");
  await page.getByRole("button", { name: "Run first crawl" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start crawl" }).click();
  await page.waitForURL(/\/audits\/[^/?]+$/);
  await expect(page.getByText("Before / after by issue type")).toBeVisible({ timeout: 90_000 });

  // AEO: assess key pages via the worker
  await page.goto("/aeo?tab=pages");
  await expect(page.getByText("No pages assessed yet")).toBeVisible();
  await page.getByRole("button", { name: "Assess key pages" }).click();
  await expect(page.getByText(/Assessment queued/)).toBeVisible();
  await expect.poll(async () => {
    await page.goto("/aeo?tab=pages");
    return page.getByText("Latest assessment per page").count();
  }, { timeout: 60_000 }).toBe(1);
  if (shots) await page.screenshot({ path: `${shots}/40-aeo-pages.png`, fullPage: true });

  // Opportunities with no GSC/keywords: honest empty state
  await page.goto("/aeo?tab=opportunities");
  await expect(page.getByText("No question opportunities yet")).toBeVisible();

  // Schema validator
  await page.goto("/aeo?tab=schema");
  await page.getByLabel("JSON-LD").fill(JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage" }));
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText(/[1-9]\d* error\(s\)/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/41-aeo-schema.png`, fullPage: true });
  await page.getByLabel("JSON-LD").fill(JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A." } }] }));
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("No issues found")).toBeVisible();

  // GEO: no AI keys connected -> notice, and saving a set without a platform is rejected
  await page.goto("/geo");
  await expect(page.getByText("Connect at least one AI platform")).toBeVisible();
  await expect(page.getByText("No AI visibility samples yet")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/42-geo.png`, fullPage: true });
  await page.goto("/geo?tab=prompts");
  await page.getByRole("button", { name: "New prompt set" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Buyers");
  await dialog.getByLabel("Prompts (one per line)").fill("best widget repair service\nhow long do widgets last");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Choose at least one platform");
  if (shots) await page.screenshot({ path: `${shots}/43-geo-dialog.png` });

  // Entity audit from crawl data
  await page.goto("/geo?tab=entity");
  await expect(page.getByText("Organization entity consistency")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/44-geo-entity.png`, fullPage: true });
});
