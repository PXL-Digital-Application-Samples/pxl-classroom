// LIVE: a deadline extension, granted in the real dialog, reaches the student's
// own page (lib/deadline-variable.mjs; found 2026-10-15 by this suite's first
// run, where the page read it from a repository the student cannot read).
//
//   OPEN_DRILL=<a drill whose deadline has not passed> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs extension
//
// WRITES: an extension for STUDENT_B on that drill, and its variable on their
// repository. The drill then locks STUDENT_B at the extended time, so verify
// that drill no more; delete it with `drill.mjs cleanup`.
import { test, expect } from "@playwright/test";
import { api } from "../live-kit.mjs";
import { ACCOUNTS, ORG, control, publishedData, signInAs, studentLink } from "./live-ui.mjs";
import { parse } from "yaml";
import { DEADLINE_VARIABLE } from "../../../lib/deadline-variable.mjs";

const ID = process.env.OPEN_DRILL;
test.skip(!ID, "OPEN_DRILL: a drill whose deadline has not passed");
const STUDENT = ACCOUNTS.STUDENT_B;

test.describe.configure({ mode: "serial" });

let extendedTo = null;
let repoName = null;

test("the lecturer grants an extension in the real dialog, and their repository carries it", async ({ page }) => {
  const doc = parse(await control(`assignments/${ID}.yml`));
  if (Date.now() > Date.parse(doc.deadline_at)) test.skip(true, `${ID}'s deadline has passed`);
  const record = JSON.parse(await control(`repositories/${ID}/${STUDENT.login.toLowerCase()}.json`));
  repoName = record.repo_name;
  // Two hours past the class deadline, on a whole minute: the form takes minutes.
  extendedTo = new Date(Math.ceil((Date.parse(doc.deadline_at) + 2 * 3600_000) / 60_000) * 60_000);

  await signInAs(page, ACCOUNTS.LECTURER);
  await publishedData(page);
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await page.getByRole("button", { name: `Actions for ${STUDENT.login}` }).first().click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: `Actions for ${STUDENT.login}` });
  // datetime-local is the browser's local time, which is this machine's.
  const local = new Date(extendedTo.getTime() - extendedTo.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await dialog.locator('input[type="datetime-local"]').first().fill(local);
  await dialog.getByPlaceholder(/Medical certificate/).fill("Live UI suite: extension delivery");
  await dialog.getByRole("button", { name: "Grant extension" }).click();
  // The wording since R7-16: what the time does for the lock, then whether
  // their page was told.
  const toast = page.locator(".toast", { hasText: `Extension granted to ${STUDENT.login} until` });
  await expect(toast).toBeVisible({ timeout: 60_000 });
  await expect(toast).toContainText("their lock and grading follow it");
  await expect(toast).toContainText("Their own page shows it.");

  // What GitHub holds now, as the lecturer reads it.
  const v = await api(`/repos/${repoName}/actions/variables/${DEADLINE_VARIABLE}`, { token: ACCOUNTS.LECTURER.token });
  expect(v.status).toBe(200);
  expect(v.data.value).toBe(extendedTo.toISOString());

  // Opened again, the dialog reads it back from their repository.
  await page.getByRole("button", { name: `Actions for ${STUDENT.login}` }).first().click();
  await expect(dialog.locator("[data-page-deadline]")).toHaveText("Their own page shows this deadline.", { timeout: 30_000 });
});

test("the student's own page shows it: the date, a countdown to it, and no reason", async ({ page }) => {
  test.skip(!extendedTo, "the grant above did not run");
  const doc = parse(await control(`assignments/${ID}.yml`));
  await signInAs(page, STUDENT);
  await publishedData(page);
  await page.goto(await studentLink(ID));
  const card = page.locator(".student-status-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  const shown = extendedTo.toLocaleString("en-GB", {
    timeZone: doc.timezone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
  await expect(card.locator(".override-alert-banner")).toHaveText(`Deadline extended to ${shown}.`, { timeout: 30_000 });
  await expect(card).not.toContainText("Live UI suite");
  await expect(card.locator(".deadline-countdown")).toContainText("Closes in");
  await expect(card.locator(".badge-success")).toHaveText("Submitted on time");
});
