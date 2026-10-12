import { test, expect } from "@playwright/test";

const shots = process.env.E2E_SCREENSHOTS;
const fixture = process.env.E2E_FIXTURE_URL ?? "http://127.0.0.1:4100";

test("backlinks import + verification, prospect research, keywords, competitors", async ({ page }) => {
  test.skip(!process.env.E2E_WITH_WORKER, "requires a running worker and fixture site");
  test.setTimeout(240_000);
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Blake Builder");
  await page.getByLabel("Work email").fill(`links${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Workspace name").fill("Links Co");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/websites?welcome=1");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website URL").fill(fixture);
  await page.getByLabel("Display name").fill("Acme Widgets");
  await page.getByRole("dialog").getByRole("button", { name: "Add website" }).click();
  await page.waitForURL(/\/websites\/[^/?]+/);

  // Backlinks: import (fixture pages link to each other) then verify via the worker
  await page.goto("/backlinks");
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByPlaceholder(/source_url,target_url/).fill(`source_url,target_url,anchor\n${fixture}/,${fixture}/about,About us\n${fixture}/missing,${fixture}/,gone`);
  await page.getByRole("dialog").getByRole("button", { name: "Import" }).click();
  await expect(page.getByText(/2 added/)).toBeVisible();
  await page.getByRole("button", { name: "Verify links now" }).click();
  await expect(page.getByText(/Queued/)).toBeVisible();
  await expect.poll(async () => {
    await page.goto("/backlinks?tab=links");
    return page.locator("tbody").getByText("unverified", { exact: true }).count();
  }, { timeout: 60_000 }).toBe(0);
  await expect(page.locator("tbody").getByText("broken", { exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/30-backlinks.png`, fullPage: true });
  await page.goto("/backlinks");
  if (shots) await page.screenshot({ path: `${shots}/31-backlinks-overview.png`, fullPage: true });

  // Pipeline: add researched prospect
  await page.goto("/backlinks?tab=pipeline");
  await page.getByRole("button", { name: "Add prospect" }).click();
  await page.getByLabel("Prospect page URL").fill(`${fixture}/services`);
  await page.getByRole("dialog").getByRole("button", { name: "Add prospect" }).click();
  await expect(page.getByText(/Prospect added/)).toBeVisible({ timeout: 30_000 });
  if (shots) await page.screenshot({ path: `${shots}/32-pipeline.png`, fullPage: true });

  // Keywords
  await page.goto("/keywords");
  await page.getByRole("button", { name: "Add keywords" }).first().click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Keywords" }).fill("widget maintenance\nhow to repair widgets\nbuy widget parts");
  await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/3 keywords added/)).toBeVisible();
  await expect(page.locator("tbody").getByText("transactional")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/33-keywords.png`, fullPage: true });
  await page.getByRole("button", { name: "Check rankings now" }).click();
  await expect(page.getByText(/Connect DataForSEO/).first()).toBeVisible();

  // Competitors
  await page.goto("/competitors");
  await page.getByLabel("Competitor domain").fill("rival-widgets.example");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("rival-widgets.example added")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/34-competitors.png`, fullPage: true });
});
