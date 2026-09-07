// 72 - The fixture harness refuses a report the app could not have written.
//
// A MOCK THAT ACCEPTS ANYTHING TESTS NOTHING, and that applies to what a spec
// STAGES as much as to what the app writes. `report.schema.json` is
// `additionalProperties: false`; eighteen specs stage report literals it would
// refuse - `org` and `assignment_title` at the root, `name` where a team has
// `team_name`, a missing `assignment_id`, which is required. They are green
// because they only RENDER the report. The divergence surfaces the moment a
// spec drives a save, which is how spec 69 came to be written: its first draft
// staged `org`, and the save it exists to guard failed against the schema
// rather than against the bug it was chasing.
//
// This file is the proof the guard fires. A guard nobody has watched work is
// indistinguishable from one that silently does nothing - and this one lives
// inside the fixture every other spec depends on, so it had better be exactly
// as strict as it claims and no stricter.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'guard-lab';

const goodReport = () => ({
  schema_version: 1,
  assignment_id: ID,
  generated_at: new Date().toISOString(),
  students: [{ github_login: 'alice-dev', acceptance_state: 'accepted', submission_status: 'on-time' }],
});

test.describe('72 - the report fixture guard', () => {
  test('THE GUARD: a root field the schema forbids is refused, naming it', async ({ page }) => {
    // `org` is the common one, and the one that got into spec 69's first draft.
    await injectAuth(page, LECTURER);
    await expect(
      setupStandardMockRoutes(page, {
        currentUser: LECTURER,
        reports: { [ID]: { ...goodReport(), org: ORG } },
      }),
    ).rejects.toThrow(/not a document the app could write/);
  });

  test('it names the spec and the schema, so the failure is actionable', async ({ page }) => {
    await injectAuth(page, LECTURER);
    const err = await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      reports: { [ID]: { ...goodReport(), assignment_title: 'Nope' } },
    }).catch((e) => e);
    expect(err.message).toContain('72-report-fixture-guard.spec.mjs');
    expect(err.message).toContain('report.schema.json');
    expect(err.message, 'and it says what to do about it').toMatch(/REPORT_FIXTURE_EXEMPT/);
  });

  test('a missing required field is refused too, not just an extra one', async ({ page }) => {
    const { assignment_id: _dropped, ...noId } = goodReport();
    await injectAuth(page, LECTURER);
    await expect(
      setupStandardMockRoutes(page, { currentUser: LECTURER, reports: { [ID]: noId } }),
    ).rejects.toThrow(/assignment_id/);
  });

  test('a row field the schema does not declare is refused', async ({ page }) => {
    // Rows are where the drift is thickest: `name` (students have `full_name`),
    // and the autograding fields that belong on a grading summary instead.
    await injectAuth(page, LECTURER);
    const bad = goodReport();
    bad.students[0].earned_points = 5;
    await expect(
      setupStandardMockRoutes(page, { currentUser: LECTURER, reports: { [ID]: bad } }),
    ).rejects.toThrow(/students\/0/);
  });

  test('A CORRECT FIXTURE PASSES - the guard is not just "throw"', async ({ page }) => {
    // The half that matters as much as the refusals. A check that rejects
    // everything is as useless as one that accepts everything, and this one
    // sits in front of every spec in the suite.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, reports: { [ID]: goodReport() } });
    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.header-logo')).toBeVisible({ timeout: 15000 });
  });

  test('the dashboard roll-up is staged through the same option and is NOT checked', async ({ page }) => {
    // `reports.dashboard` is the cross-assignment roll-up, a different document
    // with its own schema, and specs stage it PARTIALLY on purpose - a card
    // reads a handful of fields. Validating it here would refuse a dozen
    // correct fixtures; its real writes are checked by controlWriteViolation.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      reports: { dashboard: { schema_version: 1, assignments: { [ID]: { title: 'Partial' } } } },
    });
    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.header-logo')).toBeVisible({ timeout: 15000 });
  });
});
