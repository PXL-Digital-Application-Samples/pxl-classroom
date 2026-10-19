import { test, expect } from '@playwright/test';
import {
  injectAuth,
  setupStandardMockRoutes,
  LECTURER,
} from '../fixtures/e2e-fixtures.mjs';

const ORG = 'PXL-2TIN-CloudEssentials-2627';

test.describe('17 - Immediate Freeze, Lockdown & Preservation Workflows & Modal Resilience', () => {

  test('Scenario 1 (Freeze & Preserve Modal Action & Dispatch Flow): Lecturer triggers administrative freeze modal and dispatches lockdown', async ({ page }) => {
    const assignmentId = 'lab-freeze-exec';
    const assignment = {
      id: assignmentId,
      title: 'Freeze & Lockdown Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 2).toISOString(), // 2 hours ago
      template: { owner: ORG, repository: 'freeze-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Freeze & Lockdown Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 3,
          // What the report writes for a locked snapshot not yet in the
          // archive (lib/preservation-status.mjs) - 'unpreserved' was never a
          // value the report wrote, and the page now counts only students owed a copy.
          preservation_status: 'pending',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          repo_name: `${ORG}/${assignmentId}-student-dev2`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev2`,
          submission_status: 'on-time',
          commit_count: 5,
          preservation_status: 'pending',
        },
      ],
    };

    let dispatchedWorkflow = null;
    let dispatchedBody = null;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    // Capture workflow dispatch route
    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      dispatchedWorkflow = 'daily-activity.yml';
      try {
        dispatchedBody = route.request().postDataJSON();
      } catch {}
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);
    // Wait for the assignment to actually be loaded before touching a menu.
    // The freeze item is gated on the deadline having passed, which cannot be
    // known until the assignment YAML has arrived - clicking More before that
    // opens a menu that is still one item short.
    await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });

    // 1. The freeze is a More-menu action (DESIGN.md §1.2). It has to be: the
    //    preservation strip only renders once the assignment is closed, so an
    //    assignment past its deadline while still Accepting would otherwise
    //    have no route to freezing at all.
    // On the state button now, the lifecycle's one place on every tab.
    await page.locator('[data-state-menu]').click();
    const freezeBtn = page.locator('button', { hasText: 'Lock everyone out now' });
    await expect(freezeBtn).toBeVisible();

    // 2. Open confirmation modal
    await freezeBtn.click();

    const modal = page.locator('.modal-consequences');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h3')).toContainText('Confirm Immediate Freeze & Lockdown');

    // 3. Verify consequences list items
    // What it actually does (R7-10).
    await expect(modal).toContainText('runs the nightly check for the whole organization now');
    await expect(modal).toContainText('The repository becomes read-only');
    await expect(modal).toContainText('Their work is archived');
    await expect(modal).toContainText('Who is left out');
    // A reopen with no time on it stays open for good (R7-34): "they are
    // locked at their own deadline" was untrue of it.
    await expect(modal.locator('[data-freeze-left-out]')).toContainText('Students you reopened stay open, until their own deadline where it is still ahead');
    await expect(modal).toContainText('with its 2 student');

    // 4. Click Confirm Freeze & Lockdown button
    const confirmBtn = modal.getByRole('button', { name: /Confirm Freeze/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // 5. Verify success toast and modal closure
    await expect(page.locator('.toast', { hasText: /Lockdown and preservation workflow triggered successfully/i })).toBeVisible();
    await expect(modal).not.toBeVisible();

    // 6. Verify dispatch payload
    expect(dispatchedWorkflow).toBe('daily-activity.yml');
    expect(dispatchedBody?.ref).toBe('main');
    expect(dispatchedBody?.inputs?.org).toBe(ORG);
  });

  // R7-10 (review 2026-10-16): the dialog says the lock this assignment's own
  // "After the deadline" answer takes, not a demotion on every assignment.
  for (const [label, over, title, body] of [
    ['Pushing stops', { late_policy: 'block', lock_down_enabled: false }, 'Pushing stops', /Students keep the repository and its tools/],
    ['Nothing is locked', { late_policy: 'report', lock_down_enabled: false }, 'Nothing is locked', /students can still push, and late commits are flagged/],
  ]) {
    test(`R7-10: the dialog names the assignment's own lock - ${label}`, async ({ page }) => {
      const assignmentId = 'lab-freeze-policy';
      const assignment = {
        id: assignmentId, title: 'Freeze policy', organization: ORG, assignment_type: 'individual', roster_mode: 'open',
        state: 'published', deadline_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        template: { owner: ORG, repository: 'freeze-template' }, repository_name_pattern: `${assignmentId}-{github_login}`, ...over,
      };
      const report = { schema_version: 1, assignment_id: assignmentId, assignment_title: 'Freeze policy', org: ORG, generated_at: new Date().toISOString(),
        students: [{ github_login: 'student-dev1', repo_name: `${ORG}/${assignmentId}-student-dev1`, submission_status: 'on-time', commit_count: 1, preservation_status: 'pending' }] };
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, { assignments: { [assignmentId]: assignment }, reports: { [assignmentId]: report }, currentUser: LECTURER });
      await page.goto(`/dashboard/${ORG}/${assignmentId}`);
      await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });
      await page.locator('[data-state-menu]').click();
      await page.locator('button', { hasText: 'Lock everyone out now' }).click();
      const modal = page.locator('.modal-consequences');
      await expect(modal).toContainText(title);
      await expect(modal.locator('[data-freeze-lock]')).toContainText(body);
      await expect(modal).not.toContainText('Demotes Student Permissions');
    });
  }

  test('Scenario 2 (Retry Preservation Flow for Unpreserved Repositories): Dispatches targeted preservation retry', async ({ page }) => {
    const assignmentId = 'lab-preservation-retry';
    const assignment = {
      id: assignmentId,
      title: 'Preservation Retry Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 12).toISOString(),
      template: { owner: ORG, repository: 'retry-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Preservation Retry Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 2,
          preservation_status: 'pending',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          repo_name: `${ORG}/${assignmentId}-student-dev2`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev2`,
          submission_status: 'on-time',
          commit_count: 4,
          preservation_status: 'preserved',
          preserved_sha: 'abc1234567890abcdef',
        },
      ],
    };

    let dispatchedRetry = false;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      dispatchedRetry = true;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);
    // Wait for the assignment to actually be loaded before touching a menu.
    // The freeze item is gated on the deadline having passed, which cannot be
    // known until the assignment YAML has arrived - clicking More before that
    // opens a menu that is still one item short.
    await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });

    // The retry is in the preservation strip's Manage menu, in plain language.
    await page.getByRole('button', { name: /Manage/i }).click();
    // A plain locator, not getByRole('button'): these are role="menuitem", so
    // the implicit button role is overridden and getByRole('button') finds
    // nothing.
    const retryBtn = page.locator('button', { hasText: 'Try again for 1 student' });
    await expect(retryBtn).toBeVisible();

    await retryBtn.click();

    // Verify success toast
    await expect(page.locator('.toast', { hasText: /Preservation retry workflow triggered successfully/i })).toBeVisible();
    expect(dispatchedRetry).toBe(true);
  });

  test('TL-14 (A11): a student owed no copy is not counted, and a cohort that handed in nothing says so with nothing to retry', async ({ page }) => {
    const assignmentId = 'lab-nothing-owed';
    const assignment = {
      id: assignmentId, title: 'Nothing Owed Lab', organization: ORG, assignment_type: 'individual', roster_mode: 'open',
      state: 'closed', deadline_at: new Date(Date.now() - 3600 * 1000 * 12).toISOString(),
      template: { owner: ORG, repository: 'retry-template' }, repository_name_pattern: `${assignmentId}-{github_login}`,
    };
    const row = (login, extra) => ({
      github_login: login, name: login, repo_name: `${ORG}/${assignmentId}-${login}`, repo_url: `https://github.com/${ORG}/${assignmentId}-${login}`,
      submission_status: 'no-submission', commit_count: 1, lock_down_outcome: 'locked', ...extra,
    });
    const report = (students) => ({ schema_version: 1, assignment_id: assignmentId, assignment_title: 'Nothing Owed Lab', org: ORG, generated_at: new Date().toISOString(), students });
    const open = async (students) => {
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, { assignments: { [assignmentId]: assignment }, reports: { [assignmentId]: report(students) }, currentUser: LECTURER });
      await page.goto(`/dashboard/${ORG}/${assignmentId}`);
      await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });
    };

    // One with nothing to archive, one whose copy failed: one to try again.
    await open([row('student-none', { preservation_status: 'not-required' }), row('student-failed', { submission_status: 'on-time', commit_count: 3, preservation_status: 'failed' })]);
    await page.getByRole('button', { name: /Manage/i }).click();
    await expect(page.locator('button', { hasText: 'Try again for 1 student' })).toBeVisible();

    // Nobody owed a copy: said in words, and nothing offered to retry.
    await open([row('student-none', { preservation_status: 'not-required' }), row('student-none2', { preservation_status: 'not-required' })]);
    await expect(page.locator('.preservation-strip-title')).toContainText('Nothing was handed in before the deadline, so there is nothing to archive');
    const manage = page.getByRole('button', { name: /Manage/i });
    if (await manage.count()) {
      await manage.click();
      await expect(page.locator('button', { hasText: /Try again for/ })).toHaveCount(0);
    }
  });

  test('Scenario 3 (Preservation Status Badges in Individual & Group Tables): Renders the archive link under the status, and none for a team only locked', async ({ page }) => {
    const assignmentId = 'lab-status-preserved';
    const assignment = {
      id: assignmentId,
      title: 'Preservation Status Verification Lab',
      organization: ORG,
      assignment_type: 'group',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
      group_config: {
        max_team_size: 3,
        min_team_size: 2,
      },
      template: { owner: ORG, repository: 'group-template' },
      repository_name_pattern: `${assignmentId}-{team_slug}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Preservation Status Verification Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      teams: [
        {
          team_slug: 'team-preserved',
          team_name: 'Team Preserved',
          members: ['student-dev1'],
          repo_name: `${ORG}/${assignmentId}-team-preserved`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-preserved`,
          submission_status: 'on-time',
          commit_count: 6,
          preservation_status: 'preserved',
          preserved_sha: 'abc1234def5678',
        },
        {
          team_slug: 'team-locked',
          team_name: 'Team Locked',
          members: ['student-dev2'],
          repo_name: `${ORG}/${assignmentId}-team-locked`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-locked`,
          submission_status: 'on-time',
          commit_count: 3,
          lock_down_at: new Date().toISOString(),
        },
      ],
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          team_slug: 'team-preserved',
          submission_status: 'on-time',
          preservation_status: 'preserved',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          team_slug: 'team-locked',
          submission_status: 'on-time',
          lock_down_at: new Date().toISOString(),
        },
      ],
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}?tab=teams`);
    // Wait for the assignment to actually be loaded before touching a menu.
    // The freeze item is gated on the deadline having passed, which cannot be
    // known until the assignment YAML has arrived - clicking More before that
    // opens a menu that is still one item short.
    await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });

    // Team Preserved: the archive link under its status, as on the Progress
    // table - not a Preserved column of its own (asked 2026-10-20).
    await expect(page.locator('th', { hasText: /^Preserved$/ })).toHaveCount(0);
    const preservedTeamRow = page.locator('tr', { hasText: 'Team Preserved' });
    await expect(preservedTeamRow).toBeVisible();
    const preservedLink = preservedTeamRow.locator('a.archive-link');
    await expect(preservedLink).toBeVisible();
    await expect(preservedLink).toContainText('archive (abc1234)');
    // No archive_repo on this fixture ON PURPOSE: it is the pre-change report
    // shape, and a preserved row without the field must keep resolving to the
    // org's old shared archive. Deriving today's per-assignment name here would
    // 404 every submission archived before the change. The new shape is covered
    // in tests/e2e/10-deadline-failure-scenarios.spec.mjs.
    const href = await preservedLink.getAttribute('href');
    expect(href).toBe(
      `https://github.com/${ORG}/pxl-classroom-archive/tree/preserved%2Flab-status-preserved%2Fteam-preserved`,
    );

    // Team Locked, not preserved: no archive link, and its repository is the
    // icon link the Progress table uses.
    const lockedTeamRow = page.locator('tr', { hasText: 'Team Locked' });
    await expect(lockedTeamRow).toBeVisible();
    await expect(lockedTeamRow.locator('a.archive-link')).toHaveCount(0);
    await expect(lockedTeamRow.locator('a.repo-icon-link')).toHaveAttribute('href', `https://github.com/${ORG}/${assignmentId}-team-locked`);
  });

  test('Scenario 4 (Freeze Action Error Handling): Surfaces descriptive failure toast when dispatch is rejected', async ({ page }) => {
    const assignmentId = 'lab-freeze-err';
    const assignment = {
      id: assignmentId,
      title: 'Freeze Error Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
      template: { owner: ORG, repository: 'err-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Freeze Error Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 1,
        },
      ],
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    // Mock 403 error on dispatches
    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      await route.fulfill({
        status: 403,
        body: JSON.stringify({ message: 'Resource not accessible by integration' }),
      });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);
    // Wait for the assignment to actually be loaded before touching a menu.
    // The freeze item is gated on the deadline having passed, which cannot be
    // known until the assignment YAML has arrived - clicking More before that
    // opens a menu that is still one item short.
    await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });

    // Click Freeze, from the More menu
    await page.locator('[data-state-menu]').click();
    await page.locator('button', { hasText: 'Lock everyone out now' }).click();

    // Click Confirm in modal
    const modal = page.locator('.modal-consequences');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: /Confirm Freeze/i }).click();

    // Verify detailed error toast
    await expect(page.locator('.toast', { hasText: /the GitHub App's user-to-server token doesn't have actions:write/i })).toBeVisible();
  });

  test('Scenario 5 (Modal Dismissal Resilience & Non-Mutation): Modal dismisses cleanly without triggering actions', async ({ page }) => {
    const assignmentId = 'lab-freeze-dismiss-resilience';
    const assignment = {
      id: assignmentId,
      title: 'Freeze Dismiss Resilience Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
      template: { owner: ORG, repository: 'res-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Freeze Dismiss Resilience Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 2,
        },
      ],
    };

    let dispatchCount = 0;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      dispatchCount++;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);
    // Wait for the assignment to actually be loaded before touching a menu.
    // The freeze item is gated on the deadline having passed, which cannot be
    // known until the assignment YAML has arrived - clicking More before that
    // opens a menu that is still one item short.
    await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });

    // Choosing the item closes the More menu, as every menu here does, so each
    // attempt goes back in through it.
    const openFreeze = async () => {
      await page.locator('[data-state-menu]').click();
      await page.locator('button', { hasText: 'Lock everyone out now' }).click();
    };
    const modal = page.locator('.modal-consequences');

    // 1. Dismiss via Cancel button
    await openFreeze();
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();

    // 2. Dismiss via close X button
    await openFreeze();
    await expect(modal).toBeVisible();
    await modal.locator('.modal-close').click();
    await expect(modal).not.toBeVisible();

    // 3. Dismiss via overlay backdrop click
    await openFreeze();
    await expect(modal).toBeVisible();
    await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(modal).not.toBeVisible();

    expect(dispatchCount).toBe(0);
  });

});
