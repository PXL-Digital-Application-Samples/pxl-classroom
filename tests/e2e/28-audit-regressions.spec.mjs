// Browser coverage for the audit findings whose failure mode is only visible
// once the real components are running.
//
//   F3   a leftover `pxl-accept:` issue on the public broker is this
//        assignment's invitation, readable by anyone - System Health has to say
//        so, and stay quiet when there is nothing to find
//   F19  above 1 MB the Contents API answers 200 with an empty body, which
//        read as "file not found" - a big report looked absent

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, inviteToken, expandSettings } from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';

function publishedAssignment() {
  return {
    id: ID,
    title: 'Linux Processes 2026',
    organization: ORG,
    state: 'published',
    assignment_type: 'individual',
    opens_at: new Date(Date.now() - 86400000).toISOString(),
    deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
    repository_name_pattern: `${ID}-{github_login}`,
    template: { owner: ORG, repository: 'linux-template' },
    broker_repo: `broker-${ID}`,
    invite_token: inviteToken(ORG, ID),
    invite_nonce: 'e2e00001',
    invite_expires_at: '2099-01-01T00:00:00.000Z',
  };
}

const brokerRepo = {
  name: `broker-${ID}`,
  full_name: `${ORG}/broker-${ID}`,
  html_url: `https://github.com/${ORG}/broker-${ID}`,
};

async function openTroubleshoot(page, brokerIssues) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: publishedAssignment() },
    userRepos: [brokerRepo],
    brokerIssues,
  });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();
  await expandSettings(page);
  await page.locator('button', { hasText: 'Troubleshoot' }).first().click();
  const overlay = page.locator('.modal-overlay:has(.diagnostic-modal)');
  await expect(overlay).toBeVisible({ timeout: 15000 });
  // A tier auto-expands only when it is not ok, so open the broker tier
  // explicitly rather than toggling blind.
  const tier = overlay.locator('.tier-card', { hasText: /Broker|Acceptance/i }).first();
  await expect(tier).toBeVisible({ timeout: 20000 });
  if (!(await tier.locator('.tier-checks').isVisible())) {
    await tier.locator('.tier-header').click();
  }
  return overlay;
}

test.describe('28 - Audit regressions in the browser', () => {
  test('A leftover acceptance issue is reported as an exposed invitation', async ({ page }) => {
    // Closing and locking an issue on a public repo hides nothing. The broker
    // redacts the title and the hub deletes the issue - but deletion needs
    // admin, so this is the check that catches an App that does not have it.
    const overlay = await openTroubleshoot(page, [
      { number: 7, title: `pxl-accept:${inviteToken(ORG, ID)}`, state: 'closed' },
      { number: 8, title: 'Acceptance (processed)', state: 'closed' },
    ]);

    await expect(overlay).toContainText(/Invitation Exposure/i, { timeout: 20000 });
    await expect(overlay, 'it must name the issue to delete').toContainText(/#7/);
    await expect(overlay, 'and say the link is effectively public').toContainText(/public/i);
    await expect(overlay, 'redacting is not enough - the exposed link has to be retired')
      .toContainText(/regenerate/i);

    // And it must not print the token back into a screen a lecturer may share.
    await expect(overlay).not.toContainText(inviteToken(ORG, ID));
  });

  test('A clean broker raises no exposure finding', async ({ page }) => {
    const overlay = await openTroubleshoot(page, [
      { number: 8, title: 'Acceptance (processed)', state: 'closed' },
      { number: 9, title: 'Acceptance attempt (rejected)', state: 'closed' },
    ]);

    // The check runs and passes; it must not be reported as a problem. A clean
    // broker raising this would train lecturers to ignore it.
    await expect(overlay).toContainText(/Invitation Exposure/i, { timeout: 20000 });
    await expect(overlay).not.toContainText(/still carry this assignment's invitation/i);
  });

  test('A report over the Contents API size limit still loads', async ({ page }) => {
    // The API answers 200 with `content: ""` and `encoding: "none"` above 1 MB.
    // Returning null for that made a large report indistinguishable from a
    // missing one, so the view rendered its empty state over real data.
    const report = {
      schema_version: 1,
      assignment_id: ID,
      generated_at: new Date().toISOString(),
      students: [
        { github_login: 'alice-test', acceptance_state: 'accepted', submission_status: 'on-time' },
        { github_login: 'bob-test', acceptance_state: 'accepted', submission_status: 'late' },
      ],
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: publishedAssignment() },
      userRepos: [brokerRepo],
    });

    // Registered after the fixture, so it wins. Same URL, two answers: the JSON
    // media type reports "too big", the raw media type serves it.
    await page.route(`**/contents/reports/${ID}.json*`, async (route) => {
      const accept = route.request().headers()['accept'] || '';
      if (accept.includes('raw')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: `${ID}.json`, size: 2_000_000, content: '', encoding: 'none' }),
      });
    });

    await page.goto(`/dashboard/${ORG}/${ID}`);

    await expect(page.locator('body')).toContainText('alice-test', { timeout: 20000 });
    await expect(page.locator('body')).toContainText('bob-test');
  });
});
