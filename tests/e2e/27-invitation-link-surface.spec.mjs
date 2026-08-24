// The invitation link, driven through the browser.
//
// Everything here was green in the unit suite while the feature was broken in
// front of a lecturer, because the unit tests read source text. These drive the
// real components against the real fixtures:
//
//   F1  both "copy the link" paths asked a STRING for `.ok`, so both always
//       reported "no invitation link yet"
//   F2  the publish watcher toasted "the accept link is live and verified"
//       without ever fetching the token minted while it polled
//   F4  regenerate_invite existed on the workflow and nowhere in the app
//   F6  an email address in a description was accepted here and failed three
//       workflows later, taking the org's whole Pages build with it
//   F11 "Verified Live" was decided by the org index, which is true even when
//       the page a student opens 404s
//   F22 .btn-warning was used seven times and declared nowhere

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  expandSettings,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';

/** A published assignment carrying a real, resolvable invitation. */
function publishedAssignment(overrides = {}) {
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
    ...overrides,
  };
}

/** The broker has to exist, or the panel renders the "publish incomplete" card. */
const brokerRepo = {
  name: `broker-${ID}`,
  full_name: `${ORG}/broker-${ID}`,
  html_url: `https://github.com/${ORG}/broker-${ID}`,
};

async function openEditor(page, assignment, extra = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    userRepos: [brokerRepo],
    ...extra,
  });
  await page.goto(`/dashboard/${ORG}/admin`);
  await expect(page.locator('.app-header-crumbs .app-header-heading')).toBeVisible({ timeout: 15000 });
  await page.locator('.assignment-row, .assignment-item, li', { hasText: 'Linux Processes 2026' })
    .first()
    .click();
  // The editor is open once the Title field is on screen. A bare
  // `textarea, input` match resolves to the roster tab's hidden file input.
  // A published assignment collapses the fieldsets behind the settings
  // disclosure (UX_PLAN §7.1), so expand it first.
  await expandSettings(page);
}

const NEWLINE = String.fromCharCode(10);

test.describe('27 - The invitation link, end to end', () => {
  // --- F1: the link is actually there ---------------------------------------

  test('A published assignment shows its invitation link, and Copy works', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openEditor(page, publishedAssignment());

    const linkText = page.locator('.invitation-link').first();
    await expect(linkText).toBeVisible({ timeout: 15000 });

    const shown = (await linkText.textContent())?.trim() ?? '';
    expect(shown, 'the link box must not render an empty string or "null"').not.toBe('');
    expect(shown).not.toContain('null');
    expect(shown, 'the link is /:org/i/:token').toContain(`/${ORG}/i/`);
    // Truncated, not hidden (UX_PLAN §4.1): enough to recognise, never the full
    // 122 characters. The whole value lives on the title and in the clipboard.
    const token = inviteToken(ORG, ID);
    expect(shown, 'the box must not print the whole token').not.toContain(token);
    expect(shown).toContain(token.slice(0, 8));
    expect(await linkText.getAttribute('title'), 'hover gives the full link').toContain(token);

    await page.locator('.invitation-share button', { hasText: /Copy/ }).first().click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied, 'the clipboard must hold the link, not "null"').toContain(`/${ORG}/i/`);
    expect(copied, 'and the whole token, not the truncation').toContain(token);
  });

  test('The link appears when the workflow mints it, without a page reload', async ({ page }) => {
    // THE bug. Publishing writes the invitation straight into the control repo,
    // so the form the lecturer is holding has never seen it - the list was
    // loaded before the workflow ran. Re-reading it is the only way the link
    // can appear, and that re-read asked a STRING for `.ok`, so it never ran.
    //
    // Loading the editor against an assignment that ALREADY carries a token
    // does not exercise this at all: editAssignment picks it up off the list.
    // The divergence has to be in time, exactly as it is in production.
    let tokenMinted = false;
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: publishedAssignment({ invite_token: undefined, invite_nonce: undefined }) },
      userRepos: [brokerRepo],
    });

    // Registered after the fixture, so it wins: the control repo grows the
    // invitation partway through, the way publish-assignment.yml does.
    await page.route(`**/contents/assignments/${ID}.yml*`, async (route) => {
      const doc = publishedAssignment();
      const lines = [
        'schema_version: 1',
        `id: ${ID}`,
        `title: ${doc.title}`,
        'state: published',
      ];
      if (tokenMinted) {
        lines.push(`invite_token: ${doc.invite_token}`);
        lines.push(`invite_nonce: "${doc.invite_nonce}"`);
        lines.push(`invite_expires_at: ${doc.invite_expires_at}`);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: Buffer.from(lines.join(NEWLINE) + NEWLINE).toString('base64'),
          encoding: 'base64',
        }),
      });
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();
    await expandSettings(page);

    // Nothing to copy yet, and it says so rather than copying "null".
    await page.locator('.invitation-share button', { hasText: /Copy/ }).first().click();
    await expect(page.locator('.toast', { hasText: /No invitation link yet/i })).toBeVisible({ timeout: 10000 });

    // The workflow finishes.
    tokenMinted = true;
    await page.locator('button', { hasText: /Check status/i }).first().click();

    const linkText = page.locator('.invitation-link').first();
    await expect(linkText, 'the re-read must pick up the freshly minted token').toHaveAttribute(
      'title',
      new RegExp(inviteToken(ORG, ID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      { timeout: 15000 },
    );
  });

  test('An assignment published before invitations existed says so, rather than copying nothing', async ({ page }) => {
    // The honest failure. Before the fix BOTH cases produced this message,
    // which is why nobody noticed the healthy one was broken too.
    const noToken = publishedAssignment();
    delete noToken.invite_token;
    delete noToken.invite_nonce;
    await openEditor(page, noToken);

    await page.locator('.invitation-share button', { hasText: /Copy/ }).first().click();
    await expect(page.locator('.toast', { hasText: /No invitation link yet/i })).toBeVisible({ timeout: 10000 });
    // And the status line names the state rather than showing an empty box.
    await expect(page.locator('.invitation-share')).toContainText('Published, but no link');
  });

  // --- F11: liveness is the student's page, not the index -------------------

  test('"Verified Live" waits for the acceptance card, not the org index', async ({ page }) => {
    // pages/generate.mjs writes the card ONLY when the assignment has a token;
    // without one it warns, continues, and still lists the id. So the index is
    // true while every student gets a 404.
    const noToken = publishedAssignment();
    delete noToken.invite_token;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      // The index lists it - the old check would have called this "live".
      assignments: { [ID]: noToken },
      userRepos: [brokerRepo],
    });
    // ...and the card 404s, which is what a student would actually hit.
    await page.route('**/data/*/i/*.json*', (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }),
    );

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();

    await expect(
      page.locator('.published-info-card.is-success'),
      'nothing may claim the link is verified while the student page 404s',
    ).toHaveCount(0, { timeout: 10000 });
  });

  // --- F4: rotating a leaked link -------------------------------------------

  test('Republish reuses the invitation by default', async ({ page }) => {
    const dispatches = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: publishedAssignment() },
      userRepos: [brokerRepo],
      workflowDispatches: dispatches,
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();

    await page.locator('button', { hasText: 'Republish broker' }).first().click();
    const modal = page.locator('.republish-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });

    const checkbox = modal.locator('input[type="checkbox"]');
    await expect(checkbox, 'a repair must never rotate by default').not.toBeChecked();
    await expect(modal.locator('.alert-danger')).toHaveCount(0);

    await modal.locator('button', { hasText: 'Republish broker now' }).click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    const publish = dispatches.find((d) => d.workflow === 'publish-assignment.yml');
    expect(publish, 'the publish workflow must be dispatched').toBeTruthy();
    expect(publish.inputs.regenerate_invite).toBe('false');
  });

  test('Ticking regenerate states the consequence and sends the flag', async ({ page }) => {
    const dispatches = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: publishedAssignment() },
      userRepos: [brokerRepo],
      workflowDispatches: dispatches,
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();

    await page.locator('button', { hasText: 'Republish broker' }).first().click();
    const modal = page.locator('.republish-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });

    await modal.locator('input[type="checkbox"]').check();

    // The consequence is stated before it happens, not after.
    await expect(modal.locator('.alert-danger')).toContainText(/Every link already handed out stops working/i);
    const confirm = modal.locator('.modal-foot button').last();
    await expect(confirm).toContainText('Republish and retire the old link');
    await expect(confirm, 'destructive spelling is .btn-danger (DESIGN.md §3)').toHaveClass(/btn-danger/);

    await confirm.click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    const publish = dispatches.find((d) => d.workflow === 'publish-assignment.yml');
    expect(publish.inputs.regenerate_invite).toBe('true');
  });

  test('After rotating, the panel stops offering the old link', async ({ page }) => {
    // Worse than no button: the panel used to keep showing and copying a link
    // the broker now rejects as `superseded`.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: publishedAssignment() },
      userRepos: [brokerRepo],
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();

    await page.locator('button', { hasText: 'Republish broker' }).first().click();
    const modal = page.locator('.republish-modal');
    await modal.locator('input[type="checkbox"]').check();
    await modal.locator('.modal-foot button').last().click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    await page.locator('.invitation-share button', { hasText: /Copy/ }).first().click();
    await expect(
      page.locator('.toast', { hasText: /No invitation link yet/i }),
      'the retired link must not stay copyable',
    ).toBeVisible({ timeout: 10000 });
  });

  // --- F6: an email in a description ----------------------------------------

  test('An email address in the description is refused where it can be fixed', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Linux Processes 2026');
    // By placeholder: the first textarea on the page belongs to the roster tab.
    const description = page.getByPlaceholder('Optional');
    await description.fill('Questions? Mail tom.cool@pxl.be');

    const error = page.locator('.field-error-msg', { hasText: /email address/i });
    await expect(error, 'the lecturer must be told which field and why').toBeVisible({ timeout: 10000 });
    await expect(error).toContainText('tom.cool@pxl.be');
    await expect(error).toContainText(/public/i);

    await expect(
      page.locator('button', { hasText: /Save & publish/ }).first(),
      'and Save must be blocked, not silently failing three workflows later',
    ).toBeDisabled();

    // Fixing it clears the block.
    await description.fill('See Toledo for the assignment brief.');
    await expect(page.locator('.field-error-msg', { hasText: /email address/i })).toHaveCount(0);
  });

  test('Ordinary prose in a description is not flagged', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Linux Processes 2026');
    await page.getByPlaceholder('Optional')
      .fill('Implement a scheduler. Use `git push origin main` and tag v1.0.0. Score 20/20.');

    await expect(page.locator('.field-error-msg', { hasText: /email|token|key/i })).toHaveCount(0);
  });

  // --- F22 + DESIGN.md ------------------------------------------------------

  test('DESIGN.md §1.2 - the republish modal has exactly one solid button', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: publishedAssignment() },
      userRepos: [brokerRepo],
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();
    await page.locator('button', { hasText: 'Republish broker' }).first().click();

    const modal = page.locator('.republish-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('.btn-primary')).toHaveCount(1);

    // And it must be visibly a button - btn-warning was declared nowhere, so
    // seven of these rendered with the plain .btn face and nobody could tell.
    const bg = await modal.locator('.btn-primary').evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg, 'a solid primary must have a real fill').not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });

  test('The lecturer-facing buttons carry a declared class in both themes', async ({ page }) => {
    for (const theme of ['light', 'dark']) {
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, {
        currentUser: LECTURER,
        assignments: { [ID]: publishedAssignment() },
        userRepos: [brokerRepo],
      });
      await page.goto(`/dashboard/${ORG}/admin?theme=${theme}`);
      await page.locator('li, .assignment-row', { hasText: 'Linux Processes 2026' }).first().click();

      const copy = page.locator('.invitation-share button', { hasText: /Copy/ }).first();
      await expect(copy).toBeVisible({ timeout: 15000 });
      const cls = (await copy.getAttribute('class')) ?? '';
      expect(cls, `${theme}: btn-warning is declared nowhere`).not.toContain('btn-warning');
      expect(cls, `${theme}: it must use a declared §3 variant`).toContain('btn-secondary');
    }
  });
});
