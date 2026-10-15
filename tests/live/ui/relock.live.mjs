// LIVE: reopen a locked student in the real dialog, then Lock again, and ask
// GitHub each time what the student can do (review 2026-10-15, P2-57: nothing
// could lock a reopened repository again).
//
//   RELOCK_DRILL=<a verified drill> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs relock
//
// WRITES: STUDENT_B's repository on that drill is reopened and locked again, and
// its reopen record is written and removed. Their snapshot was preserved before
// either and does not move. A drill run with `--delete-one` is the better one:
// its organization ruleset then lists a deleted repository, which GitHub
// refused every reopen over until 2026-10-15.
import { test, expect } from "@playwright/test";
import { api } from "../live-kit.mjs";
import { ACCOUNTS, ORG, control, publishedData, signInAs } from "./live-ui.mjs";
import { CONTROL_REPO } from "../../../lib/deployment.mjs";
import { findOrgSubmissionLock, targetedRepositoryIds } from "../../../lib/submission-lock.mjs";

const ID = process.env.RELOCK_DRILL;
test.skip(!ID, "RELOCK_DRILL: a verified drill");
const STUDENT = ACCOUNTS.STUDENT_B;
const L = ACCOUNTS.LECTURER.token;
const MINUTE = 60_000;

/** What GitHub says holds the repository, as the lecturer reads it. */
async function held(repoName, repoId) {
  const request = (method, path, body) => api(path, { token: L, method, body });
  const org = await findOrgSubmissionLock(request, { org: ORG, assignmentId: ID });
  const covered = org.ruleset ? org.ruleset.enforcement === "active" && targetedRepositoryIds(org.ruleset).includes(repoId) : false;
  const perm = await api(`/repos/${repoName}/collaborators/${STUDENT.login}/permission`, { token: L });
  return { covered, permission: perm.data?.permission };
}

test("reopen, then Lock again: the lock comes off and goes back on, as GitHub says", async ({ page }) => {
  test.setTimeout(10 * MINUTE);
  const record = JSON.parse(await control(`lockdowns/${ID}/lockdown-record.json`));
  const row = record.results.find((r) => r.github_login.toLowerCase() === STUDENT.login.toLowerCase());
  test.skip(!row || row.lock_method !== "org-ruleset", "STUDENT_B is not locked by the organization ruleset on this drill");
  const before = await held(row.repo_name, row.repo_id);
  expect(before, "locked to start with").toEqual({ covered: true, permission: "read" });

  await signInAs(page, ACCOUNTS.LECTURER);
  await publishedData(page);
  const open = async () => {
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await page.getByRole("button", { name: `Actions for ${STUDENT.login}` }).first().click({ timeout: MINUTE });
    return page.locator(".modal-overlay .modal").locator("section", { hasText: "Reopen the repository" });
  };

  // 1. Reopen, in the real dialog.
  let section = await open();
  await section.locator("textarea").fill("Live UI suite: reopen, then lock again");
  await section.getByRole("button", { name: /Reopen repository/ }).click();
  await expect(page.locator(".toast", { hasText: `${row.repo_name} is reopened.` })).toBeVisible({ timeout: 2 * MINUTE });
  const reopened = await held(row.repo_name, row.repo_id);
  expect(reopened, "open: out of the organization ruleset and back at their permission").toEqual({ covered: false, permission: "admin" });
  const rec = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/unlocked/${STUDENT.login.toLowerCase()}.json`, { token: L });
  expect(rec.status, "the reopen record is written").toBe(200);

  // 2. Opened again, it says it was reopened and offers Lock again, not Reopen.
  section = await open();
  await expect(section.locator("[data-reopened]")).toContainText("Live UI suite: reopen, then lock again", { timeout: MINUTE });
  await expect(section.getByRole("button", { name: /Reopen repository/ })).toHaveCount(0);
  await section.getByRole("button", { name: "Lock again" }).click();
  await expect(page.locator(".toast", { hasText: `${row.repo_name} is locked again.` })).toBeVisible({ timeout: 2 * MINUTE });

  const after = await held(row.repo_name, row.repo_id);
  expect(after, "locked again: in the organization ruleset and read-only").toEqual({ covered: true, permission: "read" });
  const gone = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/unlocked/${STUDENT.login.toLowerCase()}.json`, { token: L });
  expect(gone.status, "the reopen record is gone").toBe(404);
  // And a push is refused, as the student.
  const push = await api(`/repos/${row.repo_name}/contents/drill/relock-${Date.now()}.md`, {
    token: STUDENT.token, method: "PUT", body: { message: "live: after Lock again", content: Buffer.from("no\n").toString("base64") },
  });
  expect(push.ok, `a push after Lock again was accepted (HTTP ${push.status})`).toBe(false);

  // 3. Opened once more: Reopen is offered again, the way it was before any of this.
  section = await open();
  await expect(section.getByRole("button", { name: /Reopen repository/ })).toBeVisible({ timeout: MINUTE });
});
