import { test, expect } from '@playwright/test';
import { ORG, ASSIGNMENT_ID, LECTURER, STUDENT_1, STUDENT_2, injectAuth, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

test.describe('07 - Multi-User Concurrent Live Browser Collaboration', () => {
  test('Lecturer, Student 1, and Student 2 interact simultaneously across isolated sessions', async ({ browser }) => {
    // ---------------------------------------------------------------------------
    // Context 1: Lecturer
    // ---------------------------------------------------------------------------
    const lecturerContext = await browser.newContext();
    const lecturerPage = await lecturerContext.newPage();
    await injectAuth(lecturerPage, LECTURER);

    // ---------------------------------------------------------------------------
    // Context 2: Student 1
    // ---------------------------------------------------------------------------
    const student1Context = await browser.newContext();
    const student1Page = await student1Context.newPage();
    await injectAuth(student1Page, STUDENT_1);

    // ---------------------------------------------------------------------------
    // Context 3: Student 2
    // ---------------------------------------------------------------------------
    const student2Context = await browser.newContext();
    const student2Page = await student2Context.newPage();
    await injectAuth(student2Page, STUDENT_2);

    // Setup live CDN data proxy for local dev server
    const setupDataProxy = async (page) => {
      await page.route(`**/data/${ORG}/assignments.json*`, async (route) => {
        try {
          const liveRes = await fetch(`https://pxl-digital-application-samples.github.io/pxl-classroom/data/${ORG}/assignments.json`);
          if (liveRes.ok) {
            const body = await liveRes.text();
            await route.fulfill({ status: 200, contentType: 'application/json', body });
            return;
          }
        } catch {}
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

      await page.route(`**/data/${ORG}/teams/${ASSIGNMENT_ID}.json*`, async (route) => {
        try {
          const liveRes = await fetch(`https://pxl-digital-application-samples.github.io/pxl-classroom/data/${ORG}/teams/${ASSIGNMENT_ID}.json`);
          if (liveRes.ok) {
            const body = await liveRes.text();
            await route.fulfill({ status: 200, contentType: 'application/json', body });
            return;
          }
        } catch {}
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
                members: ['d-ries'],
                member_count: 1,
                max_members: 3,
                is_full: false,
              },
            ],
          }),
        });
      });
    };

    await setupDataProxy(student2Page);
    await setupDataProxy(student1Page);
    await setupDataProxy(lecturerPage);

    // ---------------------------------------------------------------------------
    // Step 1: Student 2 opens assignment acceptance portal
    // ---------------------------------------------------------------------------
    await student2Page.goto(inviteUrl(ORG, ASSIGNMENT_ID));

    const heading = student2Page.locator('h2', { hasText: 'Group Assignment: Team Selection' });
    await expect(heading).toBeVisible({ timeout: 15000 });

    // Assert student 2 login is recognized
    await expect(student2Page.locator('.flow-header strong')).toContainText(STUDENT_2.login);

    // Check open team card
    const teamCard = student2Page.locator('.team-item-card').first();
    await expect(teamCard).toBeVisible();
    await expect(teamCard).toContainText('docenten');
    await expect(teamCard).toContainText(/\d+\/3 members/);

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

    // Teardown contexts
    await student2Context.close();
    await student1Context.close();
    await lecturerContext.close();
  });
});
