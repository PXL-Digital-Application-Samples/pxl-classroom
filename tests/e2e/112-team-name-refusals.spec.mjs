// 112 - What a student may not call a new team, said before anything is sent.
//
// Review 2026-10-14:
//   PG1 - a team name is published on the student pages, and one name holding
//         an email address failed the scan and with it the Pages deploy for
//         every organization (lib/public-text.mjs `teamNameProblem`).
//   T5b - a renamed team's old name stays with it: its members' pages loaded
//         before the rename still send it, and the hub refuses a new team
//         under it (`rejected:team-name-renamed`).
import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

const ID = 'grp-names';

async function openCreate(page, { teams = [] } = {}) {
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: {
      [ID]: {
        id: ID, title: 'Team Names Lab', organization: ORG, state: 'published', assignment_type: 'group',
        group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
        repository_name_pattern: `${ID}-{team_slug}`, broker_repo: `broker-${ID}`,
        opens_at: new Date(Date.now() - 3600_000).toISOString(),
        deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      },
    },
    teams: { [ID]: teams },
  });
  const issues = [];
  await page.route(`**/repos/${ORG}/broker-${ID}/issues`, (route) => {
    if (route.request().method() === 'POST') issues.push(route.request().postData())
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ number: 1 }) });
  });
  await page.goto(inviteUrl(ORG, ID));
  await page.locator('.tab-pill', { hasText: '+ Create New Team' }).click();
  return { issues, input: page.locator('#new-team-name'), submit: page.locator('button', { hasText: 'Create & Join Team' }) };
}

test('an email address in the name is refused on the page, and nothing is sent', async ({ page }) => {
  const { issues, input, submit } = await openCreate(page);
  await input.fill('ann.dewit@student.pxl.be');
  await expect(page.locator('[data-team-name-problem]')).toHaveText(/A team name is shown on a public page, so it cannot contain an email address\./);
  await expect(submit).toBeDisabled();
  await input.fill('The Code Crusaders');
  await expect(page.locator('[data-team-name-problem]')).toHaveCount(0);
  await expect(submit).toBeEnabled();
  expect(issues).toEqual([]);
});

test("a renamed team's old name is refused and names the team it is now", async ({ page }) => {
  const renamed = { team_slug: 'krusty-krabs', team_name: 'Krusty Krabs', members: ['someone-else'], member_count: 1, max_members: 3, is_full: false, renamed_from: ['krusty-krab'] };
  const { input, submit } = await openCreate(page, { teams: [renamed] });
  await input.fill('Krusty Krab');
  await expect(page.locator('[data-slug-renamed]')).toHaveText(/krusty-krab was the name of the team now called Krusty Krabs\. Pick another name, or join that team\./);
  await expect(submit).toBeDisabled();
  await input.fill('Krusty Krabbers');
  await expect(page.locator('[data-slug-renamed]')).toHaveCount(0);
  await expect(submit).toBeEnabled();
});
