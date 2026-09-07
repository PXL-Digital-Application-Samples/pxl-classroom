import { test, expect } from '@playwright/test';
import { ORG, ASSIGNMENT_ID, LECTURER, STUDENT_1, STUDENT_2, injectAuth, inviteUrl, inviteToken } from '../fixtures/e2e-fixtures.mjs';
import { inviteFileFor } from '../../lib/invite-token.mjs';

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
    const CARD = {
      id: ASSIGNMENT_ID,
      title: 'Test Groepsopdracht 2',
      organization: ORG,
      state: 'published',
      opens_at: new Date(Date.now() - 3600000).toISOString(),
      deadline_at: new Date(Date.now() + 86400000 * 14).toISOString(),
      assignment_type: 'group',
      group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
    };
    const DIGEST = inviteFileFor(inviteToken(ORG, ASSIGNMENT_ID));

    // Published-side fixtures. Nothing here reaches the network.
    //
    // These three routes used to try the live CDN first and fall back to a
    // fixture if it failed - "setup live CDN data proxy", from before the
    // acceptance card moved behind the token digest. What was left was a
    // hermetic spec paying for a DNS lookup, a TLS handshake and a round trip
    // to GitHub Pages inside the route handler, on the request that renders
    // `.team-item-card`, with the default 5s expect timeout waiting behind it.
    // That is the flake: green run after run, red under full-suite load, and
    // passing again on its own - which reads as "concurrency is hard" and is
    // in fact one un-timed network call.
    //
    // Both live legs were also dead or wrong. Measured 2026-09-07:
    //
    //   * teams -> 404. It fetched `data/<org>/teams/<id>.json`, the path from
    //     before the digest, so it ALWAYS fell through to the fixture below.
    //     Latency and nothing else.
    //   * assignments -> 200, which is worse. A hermetic spec was asserting
    //     against whatever is deployed right now; someone publishing over that
    //     org's assignments.json turns this red with nothing wrong in the code.
    //
    // The deliberate live variant is `tests/multiuser-live.spec.mjs`, which
    // needs real tokens and skips without them. This one is the mocked
    // sibling, so it mocks.
    const TEAMS = {
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
    };
    const ASSIGNMENTS = { schema_version: 1, assignments: { [ASSIGNMENT_ID]: CARD } };
    const json = (route, body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    const setupDataProxy = async (page) => {
      // The acceptance card and its teams file live behind the digest of the
      // invitation token, and these tokens are minted locally.
      await page.route(`**/data/${ORG}/i/${DIGEST}.json*`, (route) => json(route, { schema_version: 1, assignment: CARD }));
      // ONE definition of the assignment, not a second copy that can drift
      // from CARD - the card the invitation renders and the row the portal
      // lists are the same assignment.
      await page.route(`**/data/${ORG}/assignments.json*`, (route) => json(route, ASSIGNMENTS));
      await page.route(`**/data/${ORG}/i/${DIGEST}.teams.json*`, (route) => json(route, TEAMS));
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
