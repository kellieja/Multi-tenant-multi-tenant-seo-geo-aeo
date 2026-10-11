import { test, expect } from "@playwright/test";

const shots = process.env.E2E_SCREENSHOTS;
const snap = async (page: import("@playwright/test").Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

test("register, create workspace, add website, view dashboard and settings", async ({ page }) => {
  const email = `e2e${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Avery Analyst");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByLabel("Workspace name").fill("Northwind Digital");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/websites?welcome=1");
  await expect(page.getByText("No websites yet")).toBeVisible();
  await snap(page, "01-websites-empty");

  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website URL").fill("example.com");
  await page.getByLabel("Display name").fill("Example Co");
  await page.getByLabel("Tags").fill("demo, uk");
  await page.getByRole("dialog").getByRole("button", { name: "Add website" }).click();
  await page.waitForURL(/\/websites\/[^/?]+\?tab=overview/);
  await expect(page.getByRole("heading", { name: "Example Co" })).toBeVisible();
  await snap(page, "02-website-overview");

  await page.getByRole("link", { name: "Settings & team" }).click();
  await page.getByLabel("Max pages").fill("50");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await snap(page, "03-website-settings");

  // Duplicate domain is rejected
  await page.goto("/websites");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website URL").fill("https://www.example.com/");
  await page.getByLabel("Display name").fill("Dup");
  await page.getByRole("dialog").getByRole("button", { name: "Add website" }).click();
  await expect(page.getByText(/already in this workspace/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await snap(page, "04-websites-list");

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Executive Dashboard" })).toBeVisible();
  await expect(page.getByText("No Search Console data")).toBeVisible();
  await snap(page, "05-dashboard");

  // Data persists across a full reload / new session
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard");
  await page.goto("/websites");
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();

  await page.goto("/settings?tab=members");
  await snap(page, "06-settings-members");
  await page.goto("/settings?tab=account");
  await page.getByRole("radio", { name: "Dark" }).click();
  await snap(page, "07-settings-dark");
});
