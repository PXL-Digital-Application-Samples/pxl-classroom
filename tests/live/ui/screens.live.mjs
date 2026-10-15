// LIVE: lecturer screens on assignments the drills left on the drill org, read
// only (TV-13 L7, L8, L10, L11).
//
//   HISTORY_DRILL=<a --full-history drill> OPEN_DRILL=<an assignment before its deadline> \
//   FINISHED_DRILL=<a verified drill> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs screens
import { test, expect } from "@playwright/test";
import { parse } from "yaml";
import { ACCOUNTS, ORG, control, publishedData, signInAs } from "./live-ui.mjs";

const HISTORY = process.env.HISTORY_DRILL;
const OPEN = process.env.OPEN_DRILL;
const FINISHED = process.env.FINISHED_DRILL;

async function lecturer(page, path) {
  await signInAs(page, ACCOUNTS.LECTURER);
  await publishedData(page);
  await page.goto(path);
}
// The assignment page's More menu, as tests/fixtures/e2e-fixtures.mjs opens it.
async function moreMenu(page) {
  const trigger = page.locator('button[aria-haspopup="true"]:has(span:text-is("More"))');
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}

test.describe("a full-history assignment", () => {
  test.skip(!HISTORY, "HISTORY_DRILL");

  test("L8: Sync Starter Code is offered disabled with why, reachable from the keyboard, and opens nothing", async ({ page }) => {
    const doc = parse(await control(`assignments/${HISTORY}.yml`));
    test.skip(doc.template_full_history !== true, `${HISTORY} is not a full-history assignment`);
    await lecturer(page, `/dashboard/${ORG}/${HISTORY}`);
    await moreMenu(page);
    const row = page.locator("[data-sync-starter]");
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row).toContainText("Does not run here: students were given the template with its full history");
    for (const key of ["Enter", "Space"]) {
      if (!(await row.isVisible())) await moreMenu(page);
      await row.focus();
      await expect(row).toBeFocused();
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(1500);
    await expect(page.locator("#starter-sync-title")).toHaveCount(0);
  });

  test("L7: the editor says students get every branch and its full history, and Change opens the setting", async ({ page }) => {
    const doc = parse(await control(`assignments/${HISTORY}.yml`));
    test.skip(doc.template_full_history !== true, `${HISTORY} is not a full-history assignment`);
    await lecturer(page, `/dashboard/${ORG}/${HISTORY}?tab=settings`);
    const line = page.locator('[data-derived="template-history"]');
    await expect(line).toContainText("Students get every branch and its full history", { timeout: 90_000 });
    await line.getByRole("button", { name: "Change whether students get every branch and its full history", exact: true }).click();
    const box = page.locator("[data-template-history] input[type=checkbox]");
    await expect(box).toBeChecked();
    await expect(box).toBeFocused();
  });
});

test.describe("an assignment before its deadline", () => {
  test.skip(!OPEN, "OPEN_DRILL");

  test("L11, L10: the missing-work card is grey and says why; rows for what does not exist yet are dimmed, reachable and inert", async ({ page }) => {
    const doc = parse(await control(`assignments/${OPEN}.yml`));
    test.skip(Date.now() > Date.parse(doc.deadline_at), `${OPEN}'s deadline has passed`);
    await lecturer(page, `/dashboard/${ORG}/${OPEN}`);
    const card = page.locator('[data-card="no-submission"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    const count = Number(await card.locator(".summary-value").textContent());
    if (count > 0) {
      await expect(card.locator(".summary-value")).toHaveClass(/stat-neutral/);
      await expect(card.locator(".summary-label")).toHaveText("No submission yet");
      await expect(card).toHaveAttribute("title", "No submission yet, which is normal before the deadline");
    } else {
      await expect(card).toHaveAttribute("title", "No submission: nobody");
    }
    // Nothing is preserved before the deadline.
    await page.getByRole("button", { name: /Export/i }).first().click();
    for (const name of ["Download Manifest", "Copy CLI Download"]) {
      const row = page.locator(".export-dropdown-item", { hasText: name });
      await expect(row).toHaveAttribute("aria-disabled", "true");
      await expect(row).toContainText("Available after deadline lockdown");
      await row.focus();
      await expect(row).toBeFocused();
      expect(await row.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.55");
    }
  });
});

test.describe("an assignment after its deadline", () => {
  test.skip(!FINISHED, "FINISHED_DRILL");

  test("L11: the missing-work card is red past everyone's deadline, and its hover says so", async ({ page }) => {
    await lecturer(page, `/dashboard/${ORG}/${FINISHED}`);
    const card = page.locator('[data-card="no-submission"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    const count = Number(await card.locator(".summary-value").textContent());
    test.skip(count === 0, "nobody without a submission to show it on");
    await expect(card.locator(".summary-value")).toHaveClass(/stat-red/);
    await expect(card.locator(".summary-label")).toHaveText("No submission");
    await expect(card).toHaveAttribute("title", "No submission by their deadline");
  });
});
