import { test, expect } from "@playwright/test";

const shots = process.env.E2E_SCREENSHOTS;
const fixture = process.env.E2E_FIXTURE_URL ?? "http://127.0.0.1:4100";

test("crawl a site via the UI with the background worker and review findings", async ({ page }) => {
  test.skip(!process.env.E2E_WITH_WORKER, "requires a running worker and fixture site");
  const email = `crawl${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Casey Crawler");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Workspace name").fill("Crawl Co");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/websites?welcome=1");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website URL").fill(fixture);
  await page.getByLabel("Display name").fill("Acme Widgets");
  await page.getByRole("dialog").getByRole("button", { name: "Add website" }).click();
  await page.waitForURL(/\/websites\/[^/?]+/);
  const websiteUrl = page.url();
  await page.getByRole("link", { name: "Settings & team" }).click();
  await page.getByLabel("Delay between requests (ms)").fill("100");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  await page.goto("/audits");
  await page.getByRole("button", { name: "Run first crawl" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start crawl" }).click();
  await page.waitForURL(/\/audits\/[^/?]+$/);
  // Live progress then completion (page auto-refreshes when the job finishes)
  await expect(page.getByText("Before / after by issue type")).toBeVisible({ timeout: 90_000 });
  if (shots) await page.screenshot({ path: `${shots}/10-crawl-detail.png`, fullPage: true });

  await page.goto("/audits");
  await expect(page.getByRole("link", { name: /Redirect chain/ }).first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/11-findings.png`, fullPage: true });

  // Bulk action: ignore a finding via checkbox + bulk bar
  await page.getByRole("checkbox", { name: /Select Redirect chain/ }).first().check();
  await page.getByRole("combobox", { name: "New status" }).selectOption("IGNORED");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByText(/marked ignored/)).toBeVisible();

  await page.getByRole("link", { name: /Duplicate title tag/ }).first().click();
  await page.waitForURL(/\/audits\/findings\//, { timeout: 60_000 });
  await expect(page.getByText("Why this finding ranks where it does.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText(/task created/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/12-finding.png`, fullPage: true });

  await page.goto("/technical");
  await expect(page.getByRole("heading", { name: "Status codes" })).toBeVisible({ timeout: 60_000 });
  if (shots) await page.screenshot({ path: `${shots}/13-technical.png`, fullPage: true });
  await page.goto("/dashboard");
  if (shots) await page.screenshot({ path: `${shots}/14-dashboard.png`, fullPage: true });
  await page.goto("/integrations");
  if (shots) await page.screenshot({ path: `${shots}/15-integrations.png`, fullPage: true });
  await page.goto(websiteUrl);
});
