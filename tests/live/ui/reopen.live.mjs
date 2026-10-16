// LIVE: reopen a finished drill the way a lecturer does - move its deadline
// into the future in the real editor and save - and ask GitHub what that did
// (PXL-2TIN-DevOps-2627/groepsindeling, 2026-10-16: the save rebuilt the page
// and nothing else, so the broker the nightly had switched off skipped every
// student's attempt). Then, after the new deadline, that the broker is closed
// again: the record of the first close still said closed.
//
//   REOPEN_DRILL=<a verified drill> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs reopen
//
// WRITES: the drill's deadline moves to about 25 minutes from now and its
// broker is switched on again; STUDENT_A opens one acceptance issue (they
// accepted before, so the hub answers it from their record - what matters is
// that it reached the hub at all). At the new deadline the sentinel stops
// writes again and the finalize it dispatches closes the broker. About 45
// minutes in all, most of it waiting for the deadline.
import { test, expect } from "@playwright/test";
import { parse } from "yaml";
import { api, openAcceptanceIssue, signAcceptance } from "../live-kit.mjs";
import { ACCOUNTS, ORG, control, signInAs } from "./live-ui.mjs";
import { brokerRepoName } from "../../../lib/broker-repo.mjs";
import { linkSecretFrom, parseInviteFields } from "../../../lib/invite-token-format.mjs";
import { HUB_OWNER, HUB_REPO_NAME } from "../../../lib/deployment.mjs";

const ID = process.env.REOPEN_DRILL;
test.skip(!ID, "REOPEN_DRILL: a verified drill");
const L = ACCOUNTS.LECTURER.token;
const MINUTE = 60_000;
const r = { ok() {}, note() {}, bad(m) { throw new Error(m); } };

let broker = null;
let target = null;

/** The broker's switch, as the lecturer reads it: "true", "false", or absent. */
async function inviteEnabled() {
  const v = await api(`/repos/${ORG}/${broker}/actions/variables/INVITE_ENABLED`, { token: L });
  return v.ok ? String(v.data?.value) : v.status === 404 ? "absent" : `HTTP ${v.status}`;
}

async function brokerHoldsKey() {
  const s = await api(`/repos/${ORG}/${broker}/actions/secrets`, { token: L });
  if (!s.ok) throw new Error(`broker secrets: HTTP ${s.status}`);
  return (s.data?.secrets || []).some((x) => x.name === "PXL_BROKER_PRIVATE_KEY");
}

test.describe.configure({ mode: "serial" });

test("a finished drill's deadline moved into the future and saved: the save publishes, and a student's attempt reaches the hub", async ({ page }) => {
  test.setTimeout(15 * MINUTE);
  const doc = parse(await control(`assignments/${ID}.yml`));
  broker = brokerRepoName({ assignment: doc, assignmentId: ID });
  // REOPEN_RESUME: a run that already moved the deadline and saw the broker
  // switched on carries on from the attempt, rather than needing a new drill.
  const resume = process.env.REOPEN_RESUME === "1" && Date.parse(doc.deadline_at) > Date.now();
  if (resume) {
    target = new Date(doc.deadline_at);
  } else {
    test.skip(Date.parse(doc.deadline_at) > Date.now(), `${ID} has not passed its deadline`);
    expect(["false", "absent"], "the finished drill's broker is switched off").toContain(await inviteEnabled());

    // On a whole minute: the form takes minutes, in this machine's local time.
    target = new Date(Math.ceil((Date.now() + 25 * MINUTE) / MINUTE) * MINUTE);
    const local = new Date(target.getTime() - target.getTimezoneOffset() * MINUTE).toISOString().slice(0, 16);
    await signInAs(page, ACCOUNTS.LECTURER);
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await page.getByPlaceholder("e.g. Linux Processes 2026").waitFor({ timeout: 60_000 });
    await page.locator(".field", { has: page.locator("label", { hasText: /^Deadline/ }) }).locator('input[type="datetime-local"]').fill(local);
    await page.getByRole("button", { name: "Save", exact: true }).click();
  }

  // The save published: the broker is on, and holds its key again.
  await expect.poll(inviteEnabled, { timeout: 8 * MINUTE, intervals: [15_000] }).toBe("true");
  expect(await brokerHoldsKey(), "the broker's key is back").toBe(true);
  expect(Date.parse(parse(await control(`assignments/${ID}.yml`)).deadline_at)).toBe(target.getTime());

  // An attempt now reaches the hub, where this morning's were skipped. Signed
  // with the account's id, which only GitHub knows.
  const secret = linkSecretFrom(parseInviteFields(await control(`assignments/${ID}.yml`)));
  const me = await api("/user", { token: ACCOUNTS.STUDENT_A.token });
  if (!me.ok) throw new Error(`STUDENT_A: HTTP ${me.status}`);
  const student = { ...ACCOUNTS.STUDENT_A, id: me.data.id, login: me.data.login };
  const title = await signAcceptance({ secret, assignmentId: ID, student }, r);
  const issue = await openAcceptanceIssue({ org: ORG, broker, title, student }, r);
  // Matched on the HUB, by issue number: the broker renames the issue once it
  // has handled it, so no broker run can be found by the title it was opened
  // with - and a hub run for this issue is the proof the broker dispatched.
  await expect.poll(async () => {
    const runs = await api(`/repos/${HUB_OWNER}/${HUB_REPO_NAME}/actions/workflows/acceptance-handler.yml/runs?per_page=20`, { token: L });
    const hub = (runs.data?.workflow_runs || []).find((w) => w.display_title === `acceptance ${ORG}/${broker}#${issue}`);
    return hub ? `${hub.status}/${hub.conclusion}` : "none yet";
  }, { timeout: 8 * MINUTE, intervals: [15_000] }).toBe("completed/success");
});

test("after the new deadline the broker is switched off again, and its key removed", async () => {
  test.skip(!target, "the reopen above did not run");
  // The publish marked the closed broker as on again (broker-reopened.json),
  // so after the new deadline the queue owes it the close alone (`close_only`,
  // scripts/find-finalizable.mjs, R7-4) - at the finalize the sentinel
  // dispatches, or the nightly after it.
  test.setTimeout(Math.max(0, target.getTime() - Date.now()) + 50 * MINUTE);
  await expect.poll(inviteEnabled, { timeout: Math.max(0, target.getTime() - Date.now()) + 45 * MINUTE, intervals: [60_000] }).toBe("false");
  expect(await brokerHoldsKey(), "the broker's key is gone again").toBe(false);
  const closed = JSON.parse(await control(`lockdowns/${ID}/broker-closed.json`));
  expect(closed.closed && closed.key_removed, JSON.stringify(closed)).toBe(true);
  expect(Date.parse(closed.at), "a close for THIS deadline").toBeGreaterThan(target.getTime());
});
