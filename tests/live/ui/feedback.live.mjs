// LIVE: feedback pull requests on a `master` template, opened by all three
// surfaces and checked on GitHub after each (TV-3; review S1: every surface
// spelled `main`, so a `master` template failed every student).
//
//   node tests/live/drill.mjs start --feedback ... then verify it, then
//   FEEDBACK_DRILL=<that drill> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs feedback
//
// The CLI opens STUDENT_A's (`feedback open --login`, after a dry run that
// opens nothing), the page's Open feedback PRs opens STUDENT_B's and must not
// open a second one for A, and the workflow then finds both and opens nothing.
// WRITES: one draft pull request in each student's repository, and their
// repository records.
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { api, root, sleep } from "../live-kit.mjs";
import { ACCOUNTS, ORG, control, publishedData, signInAs } from "./live-ui.mjs";
import { HUB_OWNER, HUB_REPO_NAME } from "../../../lib/deployment.mjs";
import { feedbackPrTitle } from "../../../lib/feedback-pr.mjs";

const ID = process.env.FEEDBACK_DRILL;
test.skip(!ID, "FEEDBACK_DRILL: a verified drill started with --feedback");
const [A, B] = [ACCOUNTS.STUDENT_A, ACCOUNTS.STUDENT_B];
const L = ACCOUNTS.LECTURER;
const MINUTE = 60_000;
const ON_TIME = "drill: on-time submission";

/** Every pull request into the baseline, open or not: there must only ever be one. */
async function prsInto(repoName, baseline) {
  const res = await api(`/repos/${repoName}/pulls?state=all&base=${baseline}&per_page=100`, { token: L.token });
  if (!res.ok) throw new Error(`${repoName} pulls: HTTP ${res.status}`);
  return res.data;
}

/** The one pull request, as GitHub has it: from master into the baseline, a draft, the student's commit and nothing else. */
async function expectTheOnePr(student, repoName, doc) {
  const prs = await prsInto(repoName, doc.feedback_pr_baseline_branch);
  expect(prs.length, `${student.login}: exactly one feedback pull request`).toBe(1);
  const [pr] = prs;
  expect([pr.head.ref, pr.base.ref, pr.draft, pr.state], `${student.login}: master into the baseline, a draft, open`)
    .toEqual(["master", doc.feedback_pr_baseline_branch, true, "open"]);
  expect(pr.title).toBe(feedbackPrTitle(doc, ID));
  const commits = (await api(`/repos/${repoName}/pulls/${pr.number}/commits`, { token: L.token })).data;
  expect(commits.map((c) => c.commit.message), `${student.login}: their own commit, not the template's`).toEqual([ON_TIME]);
  const record = JSON.parse(await control(`repositories/${ID}/${student.login.toLowerCase()}.json`));
  expect([record.feedback_pr_number, record.feedback_pr_url], `${student.login}: the record names it`).toEqual([pr.number, pr.html_url]);
  return pr;
}

test("feedback pull requests on a master template: CLI, page and workflow each open the right one, and only once", async ({ page }) => {
  test.setTimeout(20 * MINUTE);
  const doc = parse(await control(`assignments/${ID}.yml`));
  expect(doc.feedback_pr, "a --feedback drill").toBe(true);
  expect(doc.submission_ref).toBe("refs/heads/master");
  const repoOf = async (s) => JSON.parse(await control(`repositories/${ID}/${s.login.toLowerCase()}.json`)).repo_name;
  const [repoA, repoB] = [await repoOf(A), await repoOf(B)];
  for (const repo of [repoA, repoB]) {
    test.skip((await prsInto(repo, doc.feedback_pr_baseline_branch)).length > 0, `${repo} already has a feedback pull request: start a new drill`);
  }

  // The CLI, as the lecturer, with its own config directory.
  const work = mkdtempSync(join(tmpdir(), "pxl-cli-feedback-"));
  try {
    const cfg = join(work, "config");
    mkdirSync(join(cfg, "pxl-classroom"), { recursive: true });
    writeFileSync(join(cfg, "pxl-classroom", "token"), JSON.stringify({ access_token: L.token, obtained_at: new Date().toISOString() }));
    const cli = (...args) => spawnSync(process.execPath, [join(root, "cli", "bin", "pxl-classroom.mjs"), ...args], {
      encoding: "utf8", env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg }, timeout: 5 * MINUTE,
    });

    // 1. A dry run opens nothing.
    const dry = cli("feedback", "open", "--org", ORG, "--assignment", ID, "--dry-run");
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    expect((await prsInto(repoA, doc.feedback_pr_baseline_branch)).length, "a dry run opened a pull request").toBe(0);

    // 2. The CLI opens A's, and only A's.
    const open = cli("feedback", "open", "--org", ORG, "--assignment", ID, "--login", A.login);
    expect(open.status, open.stdout + open.stderr).toBe(0);
    const prA = await expectTheOnePr(A, repoA, doc);
    expect((await prsInto(repoB, doc.feedback_pr_baseline_branch)).length, "--login opened another student's").toBe(0);

    // ...and again opens nothing.
    const again = cli("feedback", "open", "--org", ORG, "--assignment", ID, "--login", A.login);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect((await expectTheOnePr(A, repoA, doc)).number).toBe(prA.number);

    // 3. The page opens B's, and finds A's rather than opening a second.
    await signInAs(page, L);
    await publishedData(page);
    await page.goto(`/dashboard/${ORG}/${ID}?tab=grading`);
    await page.locator('button[title="Feedback pull requests"]').click({ timeout: MINUTE });
    await page.getByRole("menuitem", { name: /Open feedback PRs/ }).click();
    const dialog = page.getByRole("dialog", { name: "Open Feedback Pull Requests" });
    await dialog.getByRole("button", { name: /^Open Feedback PRs on \d+ Repo/ }).click();
    await expect(dialog).toBeHidden({ timeout: 3 * MINUTE });
    const prB = await expectTheOnePr(B, repoB, doc);
    expect((await expectTheOnePr(A, repoA, doc)).number, "the page opened a second one for A").toBe(prA.number);

    // 4. The workflow finds both and opens nothing.
    const since = Date.now() - 5_000;
    const hub = `/repos/${HUB_OWNER}/${HUB_REPO_NAME}`;
    const sent = await api(`${hub}/actions/workflows/open-feedback-prs.yml/dispatches`, {
      token: L.token, method: "POST", body: { ref: "main", inputs: { org: ORG, assignment_id: ID } },
    });
    expect(sent.ok, `dispatch: HTTP ${sent.status}`).toBe(true);
    let run = null;
    for (let waited = 0; waited < 12 * MINUTE && run?.status !== "completed"; waited += 10_000) {
      await sleep(10_000);
      const runs = (await api(`${hub}/actions/workflows/open-feedback-prs.yml/runs?per_page=10`, { token: L.token })).data?.workflow_runs || [];
      run = runs.find((x) => Date.parse(x.created_at) >= since && x.actor?.login?.toLowerCase() === L.login.toLowerCase()) || run;
      if (run) run = (await api(`${hub}/actions/runs/${run.id}`, { token: L.token })).data;
    }
    expect(run?.conclusion, `open-feedback-prs: ${run?.html_url ?? "no run"}`).toBe("success");
    expect((await expectTheOnePr(A, repoA, doc)).number).toBe(prA.number);
    expect((await expectTheOnePr(B, repoB, doc)).number).toBe(prB.number);

    // 5. The CLI lists both.
    const list = cli("feedback", "list", "--org", ORG, "--assignment", ID);
    expect(list.status, list.stdout + list.stderr).toBe(0);
    expect(list.stdout).toContain(`#${prA.number}`);
    expect(list.stdout).toContain(`#${prB.number}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
