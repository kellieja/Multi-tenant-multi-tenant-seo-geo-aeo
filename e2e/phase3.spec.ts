import { test, expect } from "@playwright/test";

const shots = process.env.E2E_SCREENSHOTS;
const fixture = process.env.E2E_FIXTURE_URL ?? "http://127.0.0.1:4100";

test("build a workflow visually, run it (dry-run then automatic) and review logs and tasks", async ({ page }) => {
  test.skip(!process.env.E2E_WITH_WORKER, "requires a running worker and fixture site");
  test.setTimeout(240_000);
  const email = `auto${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Avery Automator");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Workspace name").fill("Auto Co");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/websites?welcome=1");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website URL").fill(fixture);
  await page.getByLabel("Display name").fill("Fixture");
  await page.getByRole("dialog").getByRole("button", { name: "Add website" }).click();
  await page.waitForURL(/\/websites\/[^/?]+/);

  await page.goto("/audits");
  await page.getByRole("button", { name: "Run first crawl" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start crawl" }).click();
  await expect(page.getByText("Before / after by issue type")).toBeVisible({ timeout: 90_000 });

  await page.goto("/automation/workflows/new");
  await page.getByRole("button", { name: /Weekly audit → tasks/ }).click();
  await page.getByRole("radio", { name: /Dry run/ }).check({ force: true });
  if (shots) await page.screenshot({ path: `${shots}/20-builder.png`, fullPage: true });
  await page.getByRole("button", { name: "Create workflow" }).click();
  await page.waitForURL(/\/automation\/workflows\/[^/]+$/, { timeout: 60_000 });

  await page.goto("/automation");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText(/Queued 1 run/)).toBeVisible();
  await expect.poll(async () => {
    await page.goto("/automation?tab=executions");
    return page.locator("summary", { hasText: "succeeded" }).count();
  }, { timeout: 60_000 }).toBeGreaterThan(0);
  await page.locator("details summary").first().click();
  await expect(page.getByText(/Would run: Create tasks/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/21-executions.png`, fullPage: true });

  await page.goto("/automation");
  await page.getByRole("link", { name: "Weekly audit → tasks" }).click();
  await page.getByRole("radio", { name: /Automatic/ }).check({ force: true });
  await page.getByRole("button", { name: "Save workflow" }).click();
  await expect(page.getByText("Workflow saved")).toBeVisible();
  await page.goto("/automation");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect.poll(async () => {
    await page.goto("/automation?tab=tasks");
    return page.locator("tbody tr").count();
  }, { timeout: 90_000 }).toBeGreaterThan(0);
  if (shots) await page.screenshot({ path: `${shots}/22-tasks.png`, fullPage: true });
  await page.goto("/automation?tab=jobs");
  if (shots) await page.screenshot({ path: `${shots}/23-jobs.png`, fullPage: true });
});
