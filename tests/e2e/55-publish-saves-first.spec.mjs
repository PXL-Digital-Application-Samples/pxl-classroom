// 55 - Publish saves what is on screen, not what was saved last time.
//
// `publish-assignment.yml` reads the STORED assignment document. So pressing
// "Publish (create broker, enable nightly)" with unsaved edits dispatched
// against the PREVIOUS version - and the workflow then wrote `state: published`
// onto that older document. The edits were simply not part of what went live.
//
// Nothing reported it. The publish succeeded, the broker appeared, the
// assignment turned green - and the thing students accepted was not the thing
// on screen. A lecturer who changed a deadline and pressed Publish had every
// reason to believe the new deadline was live.
//
// saveAssignment's own docstring warns about exactly this shape - "dispatching
// the publish workflow for a YAML the commit failed to write runs it against
// the OLD document" - and `Save & publish` was gated on it. The lifecycle
// Publish button never was.
//
// The assertion is on the WRITE, not on "did a publish happen". A version that
// dispatches without saving still dispatches; only the committed document tells
// the two apart.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'draft-one';

const draft = () => ({
  schema_version: 1,
  id: ID,
  title: 'Draft One',
  organization: ORG,
  state: 'draft',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'starter-template' },
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-12-30T20:00:00Z',
});

test.describe('55 - the lifecycle Publish button', () => {
  test('an edit on screen is committed before the publish is dispatched', async ({ page }) => {
    const writes = [];
    const dispatches = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: draft() },
      contentWrites: writes,
      workflowDispatches: dispatches,
    });

    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    const title = page.getByPlaceholder('e.g. Linux Processes 2026');
    await expect(title).toBeVisible({ timeout: 15000 });

    // The unsaved edit. Deliberately the title, because it is written into the
    // document and is trivially greppable in the committed YAML.
    await title.fill('Edited Before Publishing');

    const publish = page.getByRole('button', { name: /Publish \(create broker/ });
    await expect(publish).toBeVisible();
    await publish.click();

    await expect
      .poll(() => dispatches.filter((d) => d.workflow === 'publish-assignment.yml').length, { timeout: 15000 })
      .toBeGreaterThan(0);

    const assignmentWrites = writes.filter((w) => w.path === `assignments/${ID}.yml`);
    expect(
      assignmentWrites.length,
      'Publish must commit the form before dispatching - the workflow reads the stored document',
    ).toBeGreaterThan(0);

    const committed = assignmentWrites[assignmentWrites.length - 1].content;
    expect(
      committed,
      'the committed document must carry the edit that was on screen',
    ).toContain('Edited Before Publishing');
  });
});
