// 89 - The student table fits the page it is on.
//
// Reported from a live cohort of 36, 2026-09-30: the table scrolled sideways
// inside its own box at full desktop width, with the commit count and the row
// menu out of view. Every cell is `white-space: nowrap`, so a column is as wide
// as its widest cell OR its heading, and three of them were wide for nothing.
// Measured here against the old layout, which needed 1407px (1582 graded):
//
//   Confirmed address  378px  the address and its note side by side
//   Repo               288px  a prefix every row shares, then the login again
//   Commits             86px  the heading, over cells of one to five characters
//
// Spec 25 cannot see this. It asks whether the PAGE scrolls sideways, and a
// table inside an `overflow-x` wrapper satisfies that however wide it gets
// (DESIGN.md §7). This measures the scroller, with values as long as real ones:
// a cohort of `alice` and `bob` proves nothing about a column whose width is
// set by its longest unbreakable token.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = '2627-autii-pe1';
const LONG_ADDRESS = 'maximiliaan.vandenbroeck@student.pxl.be';
const sha = (n) => String(n).padStart(2, '0').padEnd(40, 'b');
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

// login, address, claim flags, status, commits
const PEOPLE = [
  ['MaximiliaanVandenbroeckPXL', LONG_ADDRESS, { claim_verified: true }, 'on-time', 128],
  ['AnneliesDeSmetPXL', 'annelies.desmet@student.pxl.be', { claim_verified: false }, 'no-submission', 1],
  ['jvanderlinden', 'jeroen.vanderlinden@student.pxl.be', { claim_verified: true }, 'late', 1043],
  ['NoorElAmraniPXL', '12345678@student.pxl.be', { claim_verified: true, claim_format_allowed: false }, 'on-time', 17],
  ['TibeauClaesPXL', 'tibeau.claes@gmail.com', { claim_verified: false, claim_domain_allowed: false }, 'no-submission', 2],
];

const students = PEOPLE.map(([login, email, claim, status, commits], i) => ({
  github_login: login,
  acceptance_state: 'provisioned',
  submission_status: status,
  repo_name: `${ORG}/${ID}-${login}`,
  repo_url: `https://github.com/${ORG}/${ID}-${login}`,
  claimed_email: email,
  claim_domain_allowed: true,
  claim_format_allowed: true,
  ...claim,
  latest_observed_sha: sha(i + 1),
  latest_observed_at: hoursAgo(1),
  latest_commit_date: hoursAgo(i * 20 + 1),
  commit_count: commits,
}));

const assignment = {
  schema_version: 1,
  id: ID,
  title: 'pxl-2627-autii-pe1',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 150,
  require_claim: true,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'autii-template' },
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
};

const report = { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students };

const summary = {
  schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), graded_by: 'lecturer1', runner: 'github_actions',
  students: PEOPLE.map(([login], i) => ({
    login, earned_points: i * 2, total_points: 10, ci_status: i % 2 ? 'failure' : 'success',
    ci_run_url: `https://x/${i}`, score_source: 'annotation-json', graded_at: new Date().toISOString(),
  })),
  failed: [],
};

async function open(page, { graded = false } = {}) {
  // Past 1500px the gutter has reached its 24px cap, so this is the LEAST room a
  // full-width desktop gives the table: 1190px. Between 1240 and 1500 it gets a
  // few pixels more, and measuring there would hide them.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    reports: { [ID]: report },
    gradingSummaries: graded ? { [ID]: summary } : {},
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.getByRole('button', { name: `Actions for ${PEOPLE[0][0]}` }).first()).toBeVisible({ timeout: 15000 });
  if (graded) await expect(page.locator('.table-wrapper.desktop-only thead th.col-score')).toBeVisible();
  // Inter arrives late and on purpose (index.html defers it), and it is wider
  // than the font it replaces: measured before the swap, the same table needed
  // 38px less. Wait for it, but not for ever - a machine with no network never
  // gets it, and the caller is told which font it measured.
  return page.waitForFunction(
    () => [...document.fonts].some((f) => /Inter/.test(f.family) && f.status === 'loaded'),
    null,
    { timeout: 5000 },
  ).then(() => true, () => false);
}

/**
 * What the student table NEEDS against what its scroller has, and each column.
 *
 * `needs` is read with the table squeezed to 1px: every cell is nowrap, so it
 * cannot go below the sum of its columns, and that sum is the number. Reading
 * `scrollWidth` instead says only whether it overflows, never by how little it
 * fits - and the margin is what the next column somebody adds is paid out of.
 */
const MEASURE = () => {
  const wrapper = document.querySelector('.table-wrapper.desktop-only');
  const table = wrapper.querySelector('table');
  table.style.width = '1px';
  const needs = Math.ceil(table.getBoundingClientRect().width);
  const columns = [...table.querySelectorAll('thead th')].map((th) => [th.textContent.trim(), Math.round(th.getBoundingClientRect().width)]);
  table.style.width = '';
  return { needs, room: wrapper.clientWidth, columns };
};

const said = (m) => `the table needs ${m.needs}px and its scroller has ${m.room}px: ${JSON.stringify(m.columns)}`;

const row = (page, login) => page.locator('.table-wrapper.desktop-only tbody tr', { hasText: login });

test.describe('89 - the student table fits the page it is on', () => {
  test('nothing is out of view at full width, with realistic names', async ({ page }) => {
    await open(page);
    const m = await page.evaluate(MEASURE);
    // 1000 of 1190 in Inter. The room left over is wide enough to hold in any
    // font a runner falls back to, so this one is exact everywhere.
    expect(m.needs, said(m)).toBeLessThanOrEqual(m.room);
  });

  test('a graded assignment fits too - CI Status and Score are two more columns', async ({ page }) => {
    const inter = await open(page, { graded: true });
    const m = await page.evaluate(MEASURE);
    if (inter) {
      // 1167 of 1190. This is the tight one: 23px is less than one more column.
      expect(m.needs, said(m)).toBeLessThanOrEqual(m.room);
    } else {
      // No Inter, so the widths are some other font's and 25px of margin means
      // nothing. Still not a pass by default: before the change this table ran
      // 389px past its scroller, and no fallback font accounts for that.
      test.info().annotations.push({ type: 'font', description: 'Inter did not load; measured in the fallback font against a budget' });
      expect(m.needs - m.room, said(m)).toBeLessThan(120);
    }
  });

  test('what was shortened is still there to be read', async ({ page }) => {
    await open(page);

    // The long address is cut, and the whole of it is on hover.
    const address = row(page, PEOPLE[0][0]).locator('.claimed-address');
    await expect(address).toHaveAttribute('title', LONG_ADDRESS);
    expect(await address.evaluate((el) => el.scrollWidth > el.clientWidth), 'the long address should be cut').toBe(true);
    // A short one is not, and its note is under it rather than beside it.
    const short = row(page, PEOPLE[1][0]);
    expect(await short.locator('.claimed-address').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    const stacked = await short.evaluate((tr) => {
      const a = tr.querySelector('.claimed-address').getBoundingClientRect();
      const n = tr.querySelector('.claimed-address + .status-indicator').getBoundingClientRect();
      return n.top >= a.bottom - 1;
    });
    expect(stacked, 'the note sits under the address').toBe(true);
    // The warning a lecturer acts on keeps its words.
    await expect(row(page, PEOPLE[3][0])).toContainText('No name in the address');
    await expect(row(page, PEOPLE[4][0])).toContainText('Outside allowed domains');

    // The repository is an icon that still names itself and still goes there.
    const repo = row(page, PEOPLE[0][0]).locator('.col-repo a');
    await expect(repo).toHaveAttribute('title', `${ID}-${PEOPLE[0][0]}`);
    await expect(repo).toHaveAttribute('href', `https://github.com/${ORG}/${ID}-${PEOPLE[0][0]}`);
    await expect(row(page, PEOPLE[0][0]).getByRole('link', { name: `Repository ${ID}-${PEOPLE[0][0]}` })).toBeVisible();

    // "#" is a glyph; the column is still called Commits, and still sorts.
    const commits = page.getByRole('columnheader', { name: 'Commits' });
    await expect(commits).toBeVisible();
    await commits.click();
    await expect(commits).toHaveAttribute('aria-sort', /ascending|descending/);
  });
});
