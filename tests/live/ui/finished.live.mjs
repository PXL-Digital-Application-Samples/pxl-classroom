// LIVE: what a lecturer and each student see on a drill after its deadline,
// against what the drill's own records say. Read only.
//
//   FINISHED_DRILL=<a verified drill> GRADES_DRILL=<a verified --grades drill> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs finished
//
// Written from the suite's first look at real data (2026-10-15), which found a
// finished assignment called "Accepting" on both pages, three date formats on
// one student card, and an extension no student could ever see.
import { test, expect } from "@playwright/test";
import { parse } from "yaml";
import { ACCOUNTS, ORG, control, publishedData, signInAs, studentLink } from "./live-ui.mjs";

const FINISHED = process.env.FINISHED_DRILL;
const GRADED = process.env.GRADES_DRILL;
const STUDENTS = [ACCOUNTS.STUDENT_A, ACCOUNTS.STUDENT_B];
// The card's one date format (frontend/src/lib/format.js), in the assignment's zone.
const shown = (iso, zone) => new Date(iso).toLocaleString("en-GB", {
  timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

test.describe("a finished drill", () => {
  test.skip(!FINISHED, "FINISHED_DRILL: a drill verify passed on");

  test("the lecturer: past its deadline it is not called Accepting, and every student is archived on time", async ({ page }) => {
    const report = JSON.parse(await control(`reports/${FINISHED}.json`));
    await signInAs(page, ACCOUNTS.LECTURER);
    await publishedData(page);
    await page.goto(`/dashboard/${ORG}/${FINISHED}`);
    const state = page.locator("[data-state-menu]");
    await expect(state).toContainText("Deadline passed", { timeout: 60_000 });
    await expect(state.locator(".status-dot")).toHaveClass(/dot-neutral/);
    await expect(page.getByText("All student work is archived")).toBeVisible();
    for (const s of STUDENTS) {
      const login = s.login.toLowerCase();
      const row = report.students.find((r) => r.github_login.toLowerCase() === login);
      const tr = page.locator("tr", { hasText: s.login });
      await expect(tr).toContainText("On time");
      await expect(tr).toContainText(`archive (${row.preserved_sha.slice(0, 7)})`);
    }
  });

  for (const student of STUDENTS) {
    test(`${student.login}'s own page: one date format, the assignment's zone, and on time`, async ({ page }) => {
      const doc = parse(await control(`assignments/${FINISHED}.yml`));
      await signInAs(page, student);
      await publishedData(page);
      await page.goto(await studentLink(FINISHED));
      const card = page.locator(".student-status-card");
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(".assignment-meta")).toContainText("Deadline passed");
      await expect(page.locator(".assignment-meta .status-dot")).toHaveClass(/dot-neutral/);
      await expect(card.locator(".badge-success")).toHaveText("Submitted on time");
      await expect(card.locator(".deadline-countdown")).toHaveText(`Deadline passed (${shown(doc.deadline_at, doc.timezone)})`);
      await expect(card.locator(".latest-commit-info")).toContainText(/· \d{1,2} \w{3} \d{4}, \d{2}:\d{2} /);
      await expect(card).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}/);
    });
  }
});

test.describe("a graded drill", () => {
  test.skip(!GRADED, "GRADES_DRILL: a --grades drill verify passed on");

  test("the Grading tab shows what the nightly read from real check runs", async ({ page }) => {
    const summary = JSON.parse(await control(`grading/${GRADED}/summary.json`));
    const [scored, missing] = [STUDENTS[0].login, STUDENTS[1].login];
    const row = summary.students.find((r) => r.login.toLowerCase() === scored.toLowerCase());
    await signInAs(page, ACCOUNTS.LECTURER);
    await publishedData(page);
    await page.goto(`/dashboard/${ORG}/${GRADED}?tab=grading`);
    const table = page.locator("[data-grading-table]");
    await expect(table.locator("tr", { hasText: scored })).toContainText(`${row.earned_points}/${row.total_points}`, { timeout: 60_000 });
    await expect(table.locator("tr", { hasText: missing })).toContainText("Not handed in");
    // Everyone on the roster who handed nothing in, accepted or not: the card
    // counts the rows that say so.
    const notIn = page.locator('[data-grading-cards] [data-card="not-handed-in"]');
    const rows = await table.locator("tbody tr", { hasText: "Not handed in" }).count();
    expect(rows).toBeGreaterThan(0);
    await expect(notIn.locator(".summary-value")).toHaveText(String(rows));
    await expect(notIn.locator(".summary-value")).toHaveClass(/stat-red/);
    await expect(notIn).toHaveAttribute("title", "Nothing handed in by their deadline");
    await expect(page.locator("[data-grading-box]")).toContainText(
      `Over 1 student: average ${row.earned_points} / ${row.total_points}, median ${row.earned_points} / ${row.total_points}, 1 at full marks.`,
    );
  });
});
