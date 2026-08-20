import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

// Auto-load .env.test if present
if (existsSync('.env.test')) {
  try {
    process.loadEnvFile('.env.test');
  } catch {}
}

// Configuration from environment or defaults for test run
const ORG = process.env.TEST_ORG || 'PXL-2TIN-CloudEssentials-2627';
const ASSIGNMENT_ID = process.env.TEST_ASSIGNMENT_ID || 'test-groepsopdracht-2';
const IS_LIVE = Boolean(process.env.TEST_STUDENT1_TOKEN && process.env.TEST_STUDENT2_TOKEN);

// 3 test accounts
const LECTURER = {
  login: process.env.TEST_LECTURER_LOGIN || 'lecturerUser',
  name: 'Test Lecturer',
  token: process.env.TEST_LECTURER_TOKEN || 'mock_lecturer_token',
};

const STUDENT_1 = {
  login: process.env.TEST_STUDENT1_LOGIN || 'd-ries',
  name: 'Student One',
  token: process.env.TEST_STUDENT1_TOKEN || 'mock_student1_token',
};

const STUDENT_2 = {
  login: process.env.TEST_STUDENT2_LOGIN || 'driesTest',
  name: 'Student Two',
  token: process.env.TEST_STUDENT2_TOKEN || 'mock_student2_token',
};

test.describe('Multi-User Live Browser Test (1 Lecturer + 2 Students)', () => {
  test('Lecturer, Student 1, and Student 2 interact concurrently on group assignment', async ({ browser }) => {
    // ---------------------------------------------------------------------------
    // Context 1: Lecturer
    // ---------------------------------------------------------------------------
    const lecturerContext = await browser.newContext();
    const lecturerPage = await lecturerContext.newPage();

    const authDataFor = (user) => JSON.stringify({
      access_token: user.token,
      user: { login: user.login, name: user.name },
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    await lecturerPage.addInitScript(({ authData }) => {
      sessionStorage.setItem('pxl_auth', authData);
    }, { authData: authDataFor(LECTURER) });

    // ---------------------------------------------------------------------------
    // Context 2: Student 1 (d-ries)
    // ---------------------------------------------------------------------------
    const student1Context = await browser.newContext();
    const student1Page = await student1Context.newPage();

    await student1Page.addInitScript(({ authData }) => {
      sessionStorage.setItem('pxl_auth', authData);
    }, { authData: authDataFor(STUDENT_1) });

    // ---------------------------------------------------------------------------
    // Context 3: Student 2 (driesTest)
    // ---------------------------------------------------------------------------
    const student2Context = await browser.newContext();
    const student2Page = await student2Context.newPage();

    await student2Page.addInitScript(({ authData }) => {
      sessionStorage.setItem('pxl_auth', authData);
    }, { authData: authDataFor(STUDENT_2) });

    // If running in synthetic/local CI mode, provide route fixtures
    if (!IS_LIVE) {
      const setupMockRoutes = async (page) => {
        // Assignments JSON
        await page.route(`**/data/${ORG}/assignments.json*`, async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              schema_version: 1,
              assignments: {
                [ASSIGNMENT_ID]: {
                  id: ASSIGNMENT_ID,
                  title: 'Test Groepsopdracht 2',
                  organization: ORG,
                  state: 'published',
                  opens_at: new Date(Date.now() - 3600000).toISOString(),
                  deadline_at: new Date(Date.now() + 86400000 * 14).toISOString(),
                  assignment_type: 'group',
                  group_config: {
                    max_team_size: 3,
                    formation_mode: 'self-service',
                    allow_team_creation: true,
                  },
                },
              },
            }),
          });
        });

        // Teams JSON
        await page.route(`**/data/${ORG}/teams/${ASSIGNMENT_ID}.json*`, async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              schema_version: 1,
              assignment_id: ASSIGNMENT_ID,
              teams: [
                {
                  team_slug: 'docenten',
                  team_name: 'docenten',
                  members: [STUDENT_1.login],
                  member_count: 1,
                  max_members: 3,
                  is_full: false,
                },
              ],
            }),
          });
        });

        // GitHub API mocks
        await page.route('https://api.github.com/**', async (route) => {
          const url = route.request().url();
          if (url.includes('/user')) {
            await route.fulfill({ status: 200, body: JSON.stringify({ login: 'driesTest', id: 12345 }) });
          } else if (url.includes('/issues')) {
            await route.fulfill({
              status: 200,
              body: JSON.stringify([
                {
                  title: 'team:docenten',
                  body: JSON.stringify({
                    team_slug: 'docenten',
                    team_name: 'docenten',
                    github_login: STUDENT_1.login,
                  }),
                  user: { login: STUDENT_1.login },
                },
              ]),
            });
          } else {
            await route.fulfill({ status: 200, body: JSON.stringify({}) });
          }
        });
      };

      await setupMockRoutes(student2Page);
      await setupMockRoutes(student1Page);
      await setupMockRoutes(lecturerPage);
    }

    // ---------------------------------------------------------------------------
    // Step 1: Student 2 opens assignment acceptance portal
    // ---------------------------------------------------------------------------
    await student2Page.goto(`/${ORG}/a/${ASSIGNMENT_ID}`);

    // Wait for the team selection header to be visible
    const heading = student2Page.locator('h2', { hasText: 'Group Assignment: Team Selection' });
    await expect(heading).toBeVisible({ timeout: 15000 });

    // Assert student 2 is recognized
    await expect(student2Page.locator('.flow-header strong')).toContainText(STUDENT_2.login);

    // Assert "Join Existing Team" tab is rendered with (1 open)
    const joinTab = student2Page.locator('.tab-pill', { hasText: 'Join Existing Team' });
    await expect(joinTab).toBeVisible();

    // Verify existing team (docenten) is displayed with capacity 1/3
    const teamCard = student2Page.locator('.team-item-card').first();
    await expect(teamCard).toBeVisible();
    await expect(teamCard).toContainText('docenten');
    await expect(teamCard).toContainText('1/3 members');

    // Assert "Join Team" button is visible and active
    const joinBtn = teamCard.locator('button', { hasText: 'Join Team' });
    await expect(joinBtn).toBeVisible();
    await expect(joinBtn).toBeEnabled();

    // Click "Join Team"
    await joinBtn.click();

    // ---------------------------------------------------------------------------
    // Step 2: Lecturer opens Dashboard
    // ---------------------------------------------------------------------------
    await lecturerPage.goto(`/dashboard/${ORG}`);
    await expect(lecturerPage.locator('.header-logo')).toBeVisible();

    // Clean teardown of all 3 contexts
    await student2Context.close();
    await student1Context.close();
    await lecturerContext.close();
  });
});
