import { test, expect, type Page } from "@playwright/test";

const SAMPLE = "proj_sample_christmas";

async function resetSample(page: Page) {
  const res = await page.request.post("/api/projects/sample");
  expect(res.ok()).toBeTruthy();
}

test.describe("Ripple critical journeys", () => {
  test.beforeEach(async ({ page }) => {
    await resetSample(page);
  });

  test("project list opens the sample event with its planning areas and independent connections", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /remembers consequences/ })).toBeVisible();
    await page.getByRole("link", { name: "Explore sample event" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${SAMPLE}`));
    await expect(page.getByText("Northwind Christmas Dinner").first()).toBeVisible();
    const status = page.getByLabel("Integration status");
    await expect(status.getByText(/Dropbox/)).toBeVisible();
    await expect(status.getByText(/Gmail/)).toBeVisible();
    await expect(status.getByText(/Invitations/)).toBeVisible();
    const areas = page.getByRole("navigation", { name: "Planning areas" });
    for (const a of ["Venue", "Guests", "Catering", "Budget", "Staff", "Equipment", "Brief"]) await expect(areas.getByText(new RegExp(a))).toBeVisible();
    await expect(page.getByText("Budget forecast")).toBeVisible();
    await expect(page.getByText("$15,960").first()).toBeVisible();
  });

  test("attendance change follows consequences across areas and needs approval before anything changes", async ({ page }) => {
    await page.goto(`/projects/${SAMPLE}?area=guests`);
    const input = page.getByLabel("What changed?");
    await page.getByRole("button", { name: "Reduce attendance to 240." }).click();
    await expect(input).toHaveValue("Reduce attendance to 240.");
    await input.fill("Attendance is now 300.");
    await page.getByRole("button", { name: "Follow the consequences" }).click();
    await expect(page.getByRole("list", { name: "Progress" })).toBeVisible();
    await expect(page.getByText(/Ready to review/).first()).toBeVisible();
    await expect(page.getByText(/300 exceeds this by 40/).first()).toBeVisible();
    await expect(page.getByText(/Staff required: 4 → 5/).first()).toBeVisible();
    await expect(page.getByText(/Catering forecast: 300 × \$24/).first()).toBeVisible();
    // The forecast on the dashboard has not moved yet: nothing applies before approval.
    await expect(page.getByText("$15,960").first()).toBeVisible();
    await page.getByRole("button", { name: /^Apply \d+ of \d+/ }).click();
    await expect(page.getByRole("heading", { name: /\d+ Completed/ })).toBeVisible();
    await expect(page.getByText("300", { exact: true }).first()).toBeVisible();
  });

  test("Shah Halal → CAVA: drafts, approval, simulated send, durable wait, quote arrives, sunk deposit retained", async ({ page }) => {
    await page.goto(`/projects/${SAMPLE}?area=catering`);
    const input = page.getByLabel("What changed?");
    await input.fill("Cancel catering from Shah Halal and contact CAVA instead.");
    await page.getByRole("button", { name: "Follow the consequences" }).click();
    await expect(page.getByText(/Ready to review/).first()).toBeVisible();
    await expect(page.getByText(/cancellation notice to Shah Halal/).first()).toBeVisible();
    await expect(page.getByText(/quote from CAVA/).first()).toBeVisible();
    await expect(page.getByText(/\$600/).first()).toBeVisible();
    await expect(page.getByText("Sunk").first()).toBeVisible();
    await page.getByRole("button", { name: /^Apply \d+ of \d+/ }).click();
    await expect(page.getByText(/Simulated send/).first()).toBeVisible();
    await expect(page.getByText(/Waiting/).first()).toBeVisible();
    await expect(page.getByText(/CAVA .*quote/).first()).toBeVisible();

    // Durable: a reload keeps the waiting state.
    await page.reload();
    await expect(page.getByText(/Waiting/).first()).toBeVisible();

    await page.getByRole("tab", { name: "Demo controls" }).click();
    const fixtureRow = (label: string) => page.getByText(label, { exact: true }).locator("..").locator("..");
    // Quote before the cancellation is acknowledged: Shah's balance is still committed, so the forecast is honestly over.
    await fixtureRow("CAVA quote (240 guests)").getByRole("button", { name: "Receive" }).click();
    await expect(page.getByText("$6,480").first()).toBeVisible();
    await expect(page.getByText("$22,440").first()).toBeVisible();
    await expect(page.getByText(/prospective saving pending confirmation/).first()).toBeVisible();
    // Shah acknowledges: the balance is released, the $600 deposit stays sunk, and the total lands on $17,280.
    await fixtureRow("Shah Halal cancellation acknowledgement").getByRole("button", { name: "Receive" }).click();
    await expect(page.getByText("$17,280").first()).toBeVisible();
    await expect(page.getByText(/Sunk/).first()).toBeVisible();
    await expect(page.getByText(/Accept the CAVA/).first()).toBeVisible();
  });

  test("evidence in an inbound email never becomes a command", async ({ page }) => {
    await page.goto(`/projects/${SAMPLE}?area=catering`);
    await page.getByRole("tab", { name: "Demo controls" }).click();
    const row = page.getByText(/injection/i).first().locator("..").locator("..");
    await row.getByRole("button", { name: "Receive" }).click();
    await page.getByRole("tab", { name: "Messages" }).click();
    await expect(page.getByText(/no facts or actions were changed|Held for your review|untrusted/i).first()).toBeVisible();
    await expect(page.getByText("$15,960").first()).toBeVisible();
  });
});
