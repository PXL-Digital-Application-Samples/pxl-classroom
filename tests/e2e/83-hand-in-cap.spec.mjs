// A cap on hand-ins, on the assignment page: the count, every hand-in that was
// not graded, and a per-student exception that raises the cap.
//
// A cloud exam grades on a hand-in commit (`einde examen`), and every hand-in
// is a full deploy and ~25 Actions minutes. The cap is enforced when scores are
// read (lib/submission-marker.mjs `selectHandIn`); nothing blocks a push.
//
// The fake GitHub below answers the three reads the cap makes - the branch, the
// push run history, the check runs - for ONE student with SIX hand-ins, and
// hand-in N scores N/10, so every score on screen says which hand-in was graded.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'cloud-exam';
const LOGIN = STUDENT_1.login;
const REPO = `${ORG}/${ID}-${LOGIN}`;
const MSG = 'einde examen';
const DEADLINE = '2026-10-01T12:00:00.000Z';
const sha = (n) => String(n).padStart(2, '0').padEnd(40, 'a');
const at = (min) => new Date(Date.parse('2026-10-01T09:00:00Z') + min * 60_000).toISOString();

const assignment = {
  id: ID, title: 'Cloud Exam', organization: ORG, state: 'closed', assignment_type: 'individual',
  template: { owner: ORG, repository: 'cloud-template' },
  template_grades: true,
  deadline_at: DEADLINE,
  submission_marker: { type: 'commit_message', value: MSG, multiple: true, max_hand_ins: 5 },
};

const report = {
  schema_version: 1, generated_at: '2026-10-01T13:00:00.000Z', assignment_id: ID,
  students: [{
    github_login: LOGIN, acceptance_state: 'provisioned', submission_status: 'on-time',
    repo_name: REPO, effective_deadline_at: DEADLINE, preserved_sha: sha(6),
  }],
};

const ignored6 = { sha: sha(6), date: at(60), pushed_at: at(60), on_branch: true, number: 6, reason: 'over-limit' };
const summaryOver = {
  schema_version: 1, assignment_id: ID, generated_at: '2026-10-01T13:00:00.000Z', graded_by: 'lecturer1', runner: 'github_actions',
  students: [{
    login: LOGIN, earned_points: 5, total_points: 10, ci_status: 'success', ci_run_url: 'https://x/5', score_source: 'annotation-json',
    graded_at: '2026-10-01T13:00:00.000Z',
    hand_ins: { used: 6, allowed: 5, extra: 0, graded_sha: sha(5), graded_number: 5, ignored: [ignored6] },
  }],
  failed: [],
};

const grant = (extra, reason = 'Lab crashed at 11:40, redeploy approved', by = 'lecturer1') => ({
  type: 'hand_in_allowance', value: extra, reason, overridden_by: by, overridden_at: '2026-10-01T13:05:00.000Z',
});
const overrideDoc = (entries) => ({ schema_version: 1, assignment_id: ID, github_login: LOGIN, overrides: entries });

async function setup(page, { summary = summaryOver, overrides = null, malformedOverride = false } = {}) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    contentWrites,
    assignments: { [ID]: assignment },
    reports: { [ID]: report },
    gradingSummaries: summary ? { [ID]: summary } : {},
    controlOverrides: overrides ? { [ID]: { [LOGIN]: overrides } } : {},
  });
  if (malformedOverride) {
    await page.route(new RegExp(`/contents/overrides/${ID}$`), (route) =>
      route.fulfill({ status: 200, body: JSON.stringify([{ name: `${LOGIN}.json`, path: `overrides/${ID}/${LOGIN}.json`, type: 'file' }]) }));
    await page.route(new RegExp(`/contents/overrides/${ID}/${LOGIN}\\.json`), (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ content: Buffer.from('{ not json').toString('base64'), encoding: 'base64' }) }));
  }

  // The student's repository: six hand-ins on the branch, each pushed (and so
  // with a run), and a check run at each scoring its own number.
  const esc = REPO.replace('/', '\\/');
  await page.route(new RegExp(`/repos/${esc}/commits\\?`), (route) => {
    const page1 = Number(new URL(route.request().url()).searchParams.get('page') || 1) === 1;
    const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ sha: sha(n), commit: { message: MSG, committer: { date: at(n * 10) } } })).reverse();
    return route.fulfill({ status: 200, body: JSON.stringify(page1 ? rows : []) });
  });
  await page.route(new RegExp(`/repos/${esc}/actions/runs\\?`), (route) => {
    const page1 = Number(new URL(route.request().url()).searchParams.get('page') || 1) === 1;
    const runs = [1, 2, 3, 4, 5, 6].map((n) => ({ id: n, head_sha: sha(n), head_branch: 'main', created_at: at(n * 10), head_commit: { message: MSG, timestamp: at(n * 10) } })).reverse();
    return route.fulfill({ status: 200, body: JSON.stringify({ workflow_runs: page1 ? runs : [] }) });
  });
  await page.route(new RegExp(`/repos/${esc}/commits/([0-9a-f]{40})/check-runs`), (route) => {
    const n = Number(route.request().url().match(/commits\/(\d\d)a/)[1]);
    return route.fulfill({ status: 200, body: JSON.stringify({ check_runs: [{ id: n, name: 'run-autograding-tests', conclusion: 'success', html_url: `https://x/${n}`, output: { summary: null, annotations_count: 1 } }] }) });
  });
  await page.route(new RegExp(`/repos/${esc}/check-runs/(\\d+)/annotations`), (route) => {
    const n = route.request().url().match(/check-runs\/(\d+)\/annotations/)[1];
    return route.fulfill({ status: 200, body: JSON.stringify([{ annotation_level: 'notice', message: `{"totalPoints":${n},"maxPoints":10}` }]) });
  });

  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.getByRole('button', { name: `Actions for ${LOGIN}` }).first()).toBeVisible({ timeout: 15000 });
  return { contentWrites };
}

const panel = (page) => page.locator('.autograde-section');
const actions = (page) => page.locator('.modal-overlay .modal');
const handSection = (page) => actions(page).locator('[data-section="hand-ins"]');
const lastWrite = (writes, path) => [...writes].reverse().find((w) => w.path === path);
const overridePath = `overrides/${ID}/${LOGIN}.json`;
const summaryPath = `grading/${ID}/summary.json`;

async function openActions(page) {
  await page.getByRole('button', { name: `Actions for ${LOGIN}` }).first().click();
  await expect(actions(page)).toBeVisible();
}

test.describe('83 - A cap on hand-ins, and the exception that raises it', () => {
  test('the panel shows used / allowed, and names the hand-in that was not graded', async ({ page }) => {
    await setup(page);
    await expect(panel(page).locator('th', { hasText: 'Hand-ins' })).toBeVisible();
    await expect(panel(page).locator('tbody tr').first()).toContainText('6 / 5');
    const ignored = panel(page).locator('.autograde-ignored');
    await expect(ignored).toContainText('1 hand-in not graded:');
    await expect(ignored).toContainText(`hand-in 6 of 5 at`);
    await expect(ignored).toContainText(`(${sha(6).slice(0, 7)}) ignored: over the limit`);
  });

  test('without a cap there is no Hand-ins column and no section in the student dialog', async ({ page }) => {
    const plain = { ...summaryOver, students: [{ ...summaryOver.students[0], hand_ins: undefined }] };
    delete plain.students[0].hand_ins;
    assignment.submission_marker = { type: 'commit_message', value: MSG, multiple: true };
    try {
      await setup(page, { summary: plain });
      await expect(panel(page).locator('th', { hasText: 'Hand-ins' })).toHaveCount(0);
      await expect(panel(page).locator('.autograde-ignored')).toHaveCount(0);
      await openActions(page);
      await expect(handSection(page)).toHaveCount(0);
    } finally {
      assignment.submission_marker = { type: 'commit_message', value: MSG, multiple: true, max_hand_ins: 5 };
    }
  });

  test('the student dialog shows the count and the limit', async ({ page }) => {
    await setup(page);
    await openActions(page);
    await expect(handSection(page)).toContainText('6 made on or before the deadline, of which 5 count.');
    await expect(handSection(page)).toContainText('The limit is 5 for everyone.');
    await expect(handSection(page).getByRole('button', { name: 'Revoke the extra hand-ins' })).toHaveCount(0);
  });

  test('GRANT: +1 with a reason is recorded with who and when, and hand-in 6 counts at once', async ({ page }) => {
    const { contentWrites } = await setup(page);
    await openActions(page);
    const allow = handSection(page).getByRole('button', { name: 'Allow extra hand-ins' });
    await expect(allow, 'a reason is required').toBeDisabled();
    await handSection(page).getByLabel('Extra hand-ins for this student').fill('1');
    await handSection(page).getByLabel(/^Reason/).fill('Lab crashed at 11:40, redeploy approved');
    await allow.click();

    await expect.poll(() => lastWrite(contentWrites, overridePath)).toBeTruthy();
    const doc = JSON.parse(lastWrite(contentWrites, overridePath).content);
    expect(doc.overrides).toHaveLength(1);
    expect(doc.overrides[0]).toMatchObject({
      type: 'hand_in_allowance', value: 1, reason: 'Lab crashed at 11:40, redeploy approved', overridden_by: LECTURER.login,
    });
    expect(Date.parse(doc.overrides[0].overridden_at)).not.toBeNaN();

    // Re-read straight away: hand-in 6 now counts and scores 6.
    await expect.poll(() => lastWrite(contentWrites, summaryPath)).toBeTruthy();
    const summary = JSON.parse(lastWrite(contentWrites, summaryPath).content);
    const row = summary.students.find((s) => s.login === LOGIN);
    expect(row.earned_points).toBe(6);
    expect(row.hand_ins).toMatchObject({ used: 6, allowed: 6, extra: 1, graded_number: 6, ignored: [] });
    await expect(panel(page).locator('tbody tr').first()).toContainText('6 / 6 (+1)');
    await expect(panel(page).locator('.autograde-ignored')).toHaveCount(0);
  });

  test('REVOKE: +0 with its own reason is appended, and hand-in 6 is ignored again', async ({ page }) => {
    const { contentWrites } = await setup(page, {
      overrides: overrideDoc([grant(1)]),
      summary: { ...summaryOver, students: [{ ...summaryOver.students[0], earned_points: 6, hand_ins: { used: 6, allowed: 6, extra: 1, graded_sha: sha(6), graded_number: 6, ignored: [] } }] },
    });
    await openActions(page);
    await expect(handSection(page)).toContainText('plus 1 for this student');
    await expect(handSection(page)).toContainText('+1 granted by @lecturer1');
    const revoke = handSection(page).getByRole('button', { name: 'Revoke the extra hand-ins' });
    await expect(revoke, 'a reason is required').toBeDisabled();
    await handSection(page).getByLabel(/^Reason/).fill('Granted to the wrong student');
    await revoke.click();

    await expect.poll(() => lastWrite(contentWrites, overridePath)).toBeTruthy();
    const doc = JSON.parse(lastWrite(contentWrites, overridePath).content);
    // Append-only: the grant stays on record beside its revocation.
    expect(doc.overrides.map((e) => [e.type, e.value])).toEqual([['hand_in_allowance', 1], ['hand_in_allowance', 0]]);
    expect(doc.overrides[1]).toMatchObject({ reason: 'Granted to the wrong student', overridden_by: LECTURER.login });

    await expect.poll(() => lastWrite(contentWrites, summaryPath)).toBeTruthy();
    const row = JSON.parse(lastWrite(contentWrites, summaryPath).content).students.find((s) => s.login === LOGIN);
    expect(row.earned_points).toBe(5);
    expect(row.hand_ins).toMatchObject({ used: 6, allowed: 5, extra: 0 });
    expect(row.hand_ins.ignored.map((i) => i.number)).toEqual([6]);
  });

  test('GRANT with a deadline extension writes both entries, one reason', async ({ page }) => {
    const { contentWrites } = await setup(page);
    await openActions(page);
    await handSection(page).getByLabel('Extra hand-ins for this student').fill('2');
    await handSection(page).getByLabel('Also extend their deadline to (optional)').fill('2026-10-01T16:00');
    await handSection(page).getByLabel(/^Reason/).fill('Medical certificate');
    await handSection(page).getByRole('button', { name: 'Allow extra hand-ins' }).click();
    await expect.poll(() => lastWrite(contentWrites, overridePath)).toBeTruthy();
    const doc = JSON.parse(lastWrite(contentWrites, overridePath).content);
    expect(doc.overrides.map((e) => e.type)).toEqual(['hand_in_allowance', 'deadline_extension']);
    expect(doc.overrides.every((e) => e.reason === 'Medical certificate' && e.overridden_by === LECTURER.login)).toBe(true);
  });

  test('a deadline that is not later than the current one is refused, and nothing is written', async ({ page }) => {
    const { contentWrites } = await setup(page);
    await openActions(page);
    await handSection(page).getByLabel('Also extend their deadline to (optional)').fill('2026-09-30T10:00');
    await handSection(page).getByLabel(/^Reason/).fill('x');
    await handSection(page).getByRole('button', { name: 'Allow extra hand-ins' }).click();
    await expect(page.locator('.toast', { hasText: 'must be after the current one' }).first()).toBeVisible();
    expect(lastWrite(contentWrites, overridePath)).toBeUndefined();
  });

  test('an override file that cannot be read stops grading under the cap, and says why', async ({ page }) => {
    const { contentWrites } = await setup(page, { malformedOverride: true });
    await page.getByRole('button', { name: /More/ }).first().click();
    await page.locator('[role="menuitem"]', { hasText: /scores|Re-grade|Read/i }).first().click();
    await expect(page.locator('.toast', { hasText: "Could not read the students' extra hand-ins" }).first()).toBeVisible();
    expect(lastWrite(contentWrites, summaryPath)).toBeUndefined();
  });

  test('the CSV export carries the count and the exception - who, when and why', async ({ page }) => {
    await setup(page, { overrides: overrideDoc([grant(1)]), summary: { ...summaryOver, students: [{ ...summaryOver.students[0], hand_ins: { used: 6, allowed: 6, extra: 1, graded_sha: sha(6), graded_number: 6, ignored: [] } }] } });
    await page.getByRole('button', { name: /Export/ }).first().click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.export-dropdown-item', { hasText: 'Export CSV' }).click(),
    ]);
    // The export starts with a UTF-8 BOM for Excel; spelled as a code point,
    // never a literal (lint refuses an invisible character in source).
    const csv = readFileSync(await download.path(), 'utf8').replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '');
    const [header, row] = csv.trim().split('\n');
    // Quote-aware: the reason carries a comma, and a naive split cuts it.
    const split = (line) => {
      const out = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted && ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
        if (ch === '"') { quoted = !quoted; continue; }
        if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
        cur += ch;
      }
      out.push(cur);
      return out;
    };
    const cols = split(header);
    const cells = split(row);
    const cell = (name) => cells[cols.indexOf(name)];
    expect(cell('hand_ins_used')).toBe('6');
    expect(cell('hand_ins_allowed')).toBe('6');
    expect(cell('hand_ins_ignored')).toBe('0');
    expect(cell('hand_in_extra')).toBe('1');
    expect(cell('hand_in_exception_reason')).toBe('Lab crashed at 11:40, redeploy approved');
    expect(cell('hand_in_exception_by')).toBe('lecturer1');
    expect(cell('hand_in_exception_at')).toBe('2026-10-01T13:05:00.000Z');
  });
});
