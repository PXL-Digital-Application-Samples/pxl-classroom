// LIVE: a reopen with time on it, through its whole life, in the real dialogs
// (review 2026-10-16: R7-3, R7-16, R7-20, R7-28, R7-29, R7-30, R7-33, R7-40).
//
//   node tests/live/drill.mjs start --minutes 20
//   TIME_DRILL=<that drill, its deadline at least 8 minutes ahead> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs reopen-time
//
// The deadline is D. STUDENT_A is A, STUDENT_B is B.
//
//   before D   A is given an extension to D+15: the toast says the lock
//              follows it (R7-16).
//   after D    B, locked, is given one to D+40: the toast says the lock is
//              not undone by it (R7-16). B's override is then rewritten with
//              the login spelled in capitals, and the Reopen dialog still says
//              B is locked, archived and graded again then (R7-28, R7-33). B is
//              reopened and pushes.
//   D+15       A's sentinel and finalize: A is locked; B, reopened with time,
//              is deferred to D+40 and owed a copy, not "preserved" (R7-40).
//   then       B is locked again with Lock again. A is given a second extension
//              to D+30, reopened, and pushes.
//   D+30       A's second sentinel and finalize: B is still locked - a pass
//              before B's end no longer releases a Lock again (R7-30). A's
//              reopen ended: the queue owed it (R7-20), A is locked again with
//              what they pushed, and the reopen record is gone, kept under
//              relocked/ (R7-29), so the dialog offers Reopen again.
//
// WRITES on pxl-classroom-testbed: three extensions, two reopens, a Lock again,
// a capitalised override, three pushes. About 50 minutes after D. Delete the
// drill with `drill.mjs cleanup` afterwards; do not verify it.
import { test, expect } from "@playwright/test";
import { parse } from "yaml";
import { api, sleep } from "../live-kit.mjs";
import { ACCOUNTS, ORG, control, publishedData, signInAs } from "./live-ui.mjs";
import { CONTROL_REPO } from "../../../lib/deployment.mjs";
import { findOrgSubmissionLock, targetedRepositoryIds } from "../../../lib/submission-lock.mjs";

const ID = process.env.TIME_DRILL;
test.skip(!ID, "TIME_DRILL: a drill whose deadline is at least 8 minutes ahead");
const L = ACCOUNTS.LECTURER.token;
const A = ACCOUNTS.STUDENT_A;
const B = ACCOUNTS.STUDENT_B;
const MINUTE = 60_000;
const lower = (s) => String(s).toLowerCase();

const record = async () => {
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/lockdown-record.json`, { token: L });
  return res.ok ? JSON.parse(Buffer.from(res.data.content, "base64").toString("utf8")) : null;
};
const rowOf = (rec, login) => (rec?.results || []).find((x) => lower(x.github_login) === lower(login));
const exists = async (path) => (await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: L })).status;

/** Polled until `fn` answers something, or `until` passes. */
async function waitFor(what, fn, until, every = 30_000) {
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`${what}: not by ${new Date(until).toISOString()}`);
}

async function push(student, repo, branch, label) {
  return api(`/repos/${repo}/contents/drill/reopen-time-${label}-${Date.now()}.md`, {
    token: student.token, method: "PUT",
    body: { message: `live reopen-time: ${label}`, content: Buffer.from(`${label}\n`).toString("base64"), branch },
  });
}

/** Whether the organization stop holds this repository now, as the lecturer reads it. */
async function inOrgStop(repoId) {
  const request = (method, path, body) => api(path, { token: L, method, body });
  const org = await findOrgSubmissionLock(request, { org: ORG, assignmentId: ID });
  return Boolean(org.ruleset && org.ruleset.enforcement === "active" && targetedRepositoryIds(org.ruleset).includes(repoId));
}

const at = (ms) => new Date(Math.ceil(ms / MINUTE) * MINUTE);
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * MINUTE).toISOString().slice(0, 16);

async function actions(page, login) {
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await page.getByRole("button", { name: `Actions for ${login}` }).first().click({ timeout: MINUTE });
  return page.getByRole("dialog", { name: `Actions for ${login}` });
}

/**
 * An extension through the real dialog; the toast it ends with. Granted only
 * once the dialog has read the lock and reopen records, or the toast is the
 * honest "could not be read yet" (R7-36), which is not what this asks.
 */
async function grant(page, login, until, reason, { locked = false } = {}) {
  const dialog = await actions(page, login);
  if (locked) await expect(dialog.locator("section", { hasText: "Reopen the repository" })).toBeVisible({ timeout: MINUTE });
  await page.waitForLoadState("networkidle");
  await dialog.locator('input[type="datetime-local"]').first().fill(localInput(until));
  await dialog.getByPlaceholder(/Medical certificate/).first().fill(reason);
  await dialog.getByRole("button", { name: "Grant extension" }).click();
  const toast = page.locator(".toast", { hasText: `Extension granted to ${login}` });
  await expect(toast).toBeVisible({ timeout: MINUTE });
  return (await toast.textContent()) ?? "";
}

test("a reopen with time on it, through its whole life", async ({ page }) => {
  const doc = parse(await control(`assignments/${ID}.yml`));
  const D = Date.parse(doc.deadline_at);
  test.skip(!(D > Date.now() + 8 * MINUTE), `${ID}: the deadline must be at least 8 minutes ahead`);
  test.setTimeout(D + 50 * MINUTE - Date.now());
  const branch = String(doc.submission_ref || "refs/heads/main").replace("refs/heads/", "");
  const repoRec = async (s) => JSON.parse(await control(`repositories/${ID}/${lower(s.login)}.json`));
  const recA = await repoRec(A);
  const recB = await repoRec(B);
  const aEnd = at(D + 15 * MINUTE);
  const bEnd = at(D + 40 * MINUTE);
  const aEnd2 = at(D + 30 * MINUTE);

  // Every publish marks the broker on, a first one included (R7-21).
  expect(await exists(`lockdowns/${ID}/broker-reopened.json`), "the drill's publish marked its broker").toBe(200);

  await signInAs(page, ACCOUNTS.LECTURER);
  await publishedData(page);

  // Before D: nothing is locked, so the lock follows the extension (R7-16).
  const first = await grant(page, A.login, aEnd, "Live reopen-time: A, before the deadline");
  expect(first).toContain("their lock and grading follow it");

  // After D: B locked, A deferred to D+15.
  await sleep(Math.max(0, D - Date.now()));
  await waitFor("the lock at the deadline", async () => {
    const rec = await record();
    return rowOf(rec, B.login)?.lock_method && rowOf(rec, A.login)?.deferred_until ? rec : null;
  }, D + 12 * MINUTE);

  // Reopen is offered once the report says the snapshot is in the archive.
  const reportRow = async (login) => {
    const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/reports/${ID}.json`, { token: L });
    if (!res.ok) return null;
    const report = JSON.parse(Buffer.from(res.data.content, "base64").toString("utf8"));
    return (report.students || []).find((s) => lower(s.github_login) === lower(login)) ?? null;
  };
  await waitFor("the report says B is archived", async () => (await reportRow(B.login))?.preservation_status === "preserved", Date.now() + 10 * MINUTE);

  // B, locked, given time: the toast says it does not undo the lock (R7-16).
  const locked = await grant(page, B.login, bEnd, "Live reopen-time: B, after the lock", { locked: true });
  expect(locked).toContain("already locked at the deadline, and more time does not reopen it");

  // The override spelled in capitals, as a file may be (R7-28): the page
  // still finds the extension, and Reopen says when it ends (R7-33).
  const ovPath = `overrides/${ID}/${lower(B.login)}.json`;
  const ov = (await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${ovPath}`, { token: L })).data;
  const ovDoc = JSON.parse(Buffer.from(ov.content, "base64").toString("utf8"));
  const shouty = B.login.replace(/^./, (c) => c.toUpperCase()).replace(/-(.)/g, (_, c) => `-${c.toUpperCase()}`);
  const rewrite = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${ovPath}`, { token: L, method: "PUT",
    body: { message: `live reopen-time: ${shouty}`, sha: ov.sha, content: Buffer.from(JSON.stringify({ ...ovDoc, github_login: shouty }, null, 2)).toString("base64") } });
  expect(rewrite.ok, `capitalised override: HTTP ${rewrite.status}`).toBe(true);
  let section = (await actions(page, B.login)).locator("section", { hasText: "Reopen the repository" });
  await expect(section.locator("[data-reopen-until]")).toContainText("they are locked, archived and graded again then", { timeout: MINUTE });
  await expect(section).not.toContainText("so what you grade is unaffected");
  await section.locator("textarea").fill("Live reopen-time: B, reopened with time");
  await section.getByRole("button", { name: /Reopen repository/ }).click();
  await expect(page.locator(".toast", { hasText: `${recB.repo_name} is reopened.` })).toBeVisible({ timeout: 2 * MINUTE });
  const bPush = await push(B, recB.repo_name, branch, "b-after-reopen");
  expect(bPush.ok, `B pushes after the reopen (HTTP ${bPush.status})`).toBe(true);

  // D+15: A locked; B deferred to their end, and owed a copy (R7-40).
  await sleep(Math.max(0, aEnd.getTime() - Date.now()));
  const mid = await waitFor("the pass at A's extension end", async () => {
    const rec = await record();
    const a = rowOf(rec, A.login);
    const b = rowOf(rec, B.login);
    return a?.lock_method && a?.snapshot_sha && b?.reopened_at && b?.deferred_until ? rec : null;
  }, aEnd.getTime() + 12 * MINUTE);
  expect(Date.parse(rowOf(mid, B.login).deferred_until)).toBe(bEnd.getTime());
  await waitFor("the report says B is owed a copy", async () => (await reportRow(B.login))?.preservation_status === "deferred", Date.now() + 8 * MINUTE);
  // ...and A archived, which Reopen waits for.
  await waitFor("the report says A is archived", async () => (await reportRow(A.login))?.preservation_status === "preserved", Date.now() + 8 * MINUTE);

  // B locked again before their end.
  section = (await actions(page, B.login)).locator("section", { hasText: "Reopen the repository" });
  await section.getByRole("button", { name: "Lock again" }).click();
  await expect(page.locator(".toast", { hasText: `${recB.repo_name} is locked again.` })).toBeVisible({ timeout: 2 * MINUTE });
  const relockedAt = Date.now();
  expect((await push(B, recB.repo_name, branch, "b-after-lock-again")).ok, "B is refused after Lock again").toBe(false);

  // A: a second extension, which does not undo their lock, then reopened with it.
  const second = await grant(page, A.login, aEnd2, "Live reopen-time: A, a second extension", { locked: true });
  expect(second).toContain("already locked at the deadline, and more time does not reopen it");
  section = (await actions(page, A.login)).locator("section", { hasText: "Reopen the repository" });
  await expect(section.locator("[data-reopen-until]")).toContainText("they are locked, archived and graded again then", { timeout: MINUTE });
  await section.locator("textarea").fill("Live reopen-time: A, reopened with time");
  await section.getByRole("button", { name: /Reopen repository/ }).click();
  await expect(page.locator(".toast", { hasText: `${recA.repo_name} is reopened.` })).toBeVisible({ timeout: 2 * MINUTE });
  const aUnlocked = JSON.parse(await control(`lockdowns/${ID}/unlocked/${lower(A.login)}.json`)).unlocked_at;
  const aPush = await push(A, recA.repo_name, branch, "a-after-reopen");
  expect(aPush.ok, `A pushes after the reopen (HTTP ${aPush.status})`).toBe(true);
  const aHead = aPush.data?.commit?.sha;

  // D+30: A's second sentinel and its finalize.
  await sleep(Math.max(0, aEnd2.getTime() - Date.now()));
  const end = await waitFor("A locked again at the reopen's end", async () => {
    const rec = await record();
    const a = rowOf(rec, A.login);
    return a?.relocked_after === aUnlocked && a?.lock_method ? rec : null;
  }, aEnd2.getTime() + 14 * MINUTE);

  // R7-30: a pass before B's end did not release the Lock again.
  expect((await push(B, recB.repo_name, branch, "b-after-a-pass")).ok, "B is still refused after a pass before their end").toBe(false);
  expect(await inOrgStop(recB.repo_id), "B is still in the organization stop").toBe(true);
  const b = rowOf(end, B.login);
  expect(b.deferred_until, "B is not deferred again").toBeUndefined();
  expect(Math.abs(Date.parse(b.lockdown_at) - relockedAt), "B's lock time is the Lock again").toBeLessThan(3 * MINUTE);

  // R7-20, R7-29: A's reopen ended - locked with what they pushed, the record kept.
  const a = rowOf(end, A.login);
  expect(a.snapshot_sha, "A's snapshot is what they pushed after the reopen").toBe(aHead);
  expect(Date.parse(a.lockdown_at)).toBe(aEnd2.getTime());
  expect((await push(A, recA.repo_name, branch, "a-after-end")).ok, "A is refused after the reopen's end").toBe(false);
  expect(await exists(`lockdowns/${ID}/unlocked/${lower(A.login)}.json`), "A's reopen record is gone").toBe(404);
  const kept = (await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/relocked/${lower(A.login)}`, { token: L })).data || [];
  expect(kept.length, "kept under relocked/").toBeGreaterThan(0);
  const history = JSON.parse(await control(kept.at(-1).path));
  expect(history.relocked_by).toBe("pxl-classroom[bot]");
  expect(history.unlocked_at).toBe(aUnlocked);
  section = (await actions(page, A.login)).locator("section", { hasText: "Reopen the repository" });
  await expect(section.getByRole("button", { name: /Reopen repository/ }), "the dialog offers Reopen again").toBeVisible({ timeout: MINUTE });
  await expect(section.getByRole("button", { name: "Lock again" })).toHaveCount(0);

  // And the lock record was committed the moment it was written (R7-31).
  const commits = (await api(`/repos/${ORG}/${CONTROL_REPO}/commits?since=${new Date(D).toISOString()}&per_page=100`, { token: L })).data || [];
  expect(commits.some((c) => c.commit?.message === `Lock record for ${ID}`), "step 2b's commit").toBe(true);
});
