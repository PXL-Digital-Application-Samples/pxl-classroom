// The student page's "Submission tagged" banner reads a tag a student can make.
//
// 2026-10-14: the documented tag name moved to dashes in the time (git refuses
// a colon in a ref name), and the collector moved with it - but the student
// page kept its own colon-only pattern, so a student who tagged exactly as told
// never saw the banner. It reads lib/submit-tag.mjs now, like the collector.
import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

const REPO = `hw-tagged-${STUDENT_1.login}`;

async function openWithTags(page, refs) {
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: {
      'hw-tagged': {
        id: 'hw-tagged',
        title: 'Tagged Homework',
        organization: ORG,
        state: 'published',
        assignment_type: 'individual',
        opens_at: new Date(Date.now() - 3600000).toISOString(),
        deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
        repository_name_pattern: 'hw-tagged-{github_login}',
        broker_repo: 'broker-hw-tagged',
      },
    },
    userRepos: [{ name: REPO, full_name: `${ORG}/${REPO}`, html_url: `https://github.com/${ORG}/${REPO}` }],
  });
  // Registered last, so it answers before the standard routes.
  await page.route(`**/repos/${ORG}/${REPO}/git/matching-refs/tags/submit/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(refs.map((ref) => ({ ref, object: { sha: 'a'.repeat(40), type: 'commit' } }))),
    }));
  await page.goto(inviteUrl(ORG, 'hw-tagged'));
  await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible({ timeout: 10000 });
}

test.describe('110 - the tagged-submission banner on the student page', () => {
  test('a tag made with the documented command shows the banner, naming the latest', async ({ page }) => {
    await openWithTags(page, [
      'refs/tags/submit/2026-10-14T09-00-00Z-1111111',
      'refs/tags/submit/2026-10-14T14-05-00Z-2222222',
    ]);
    const banner = page.locator('.submit-tag-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Submission tagged');
    await expect(banner.locator('.submit-tag-name')).toHaveText('submit/2026-10-14T14-05-00Z-2222222');
  });

  test('a tag that is not a submit tag shows no banner', async ({ page }) => {
    await openWithTags(page, ['refs/tags/submit/yesterday-1111111']);
    await expect(page.locator('.submit-tag-banner')).toHaveCount(0);
  });
});
