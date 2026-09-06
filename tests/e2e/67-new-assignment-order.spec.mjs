// 67 - The new-assignment form, in the order the data actually flows.
//
// The form asked for a Title, then a Slug, then a Description, and only THEN -
// in a second fieldset - which template to copy. The data had always flowed the
// other way: `selectTemplate` fills the title from the template's repository
// name, `autoSyncSlug` fills the slug from the title, and the `form.id` watcher
// fills the repository name pattern from the slug.
//
// So the layout and the logic disagreed, and the layout won. `selectTemplate`
// fills the title ONLY WHEN IT IS EMPTY - correctly, since it must not stamp on
// something a lecturer typed - and a lecturer working down the form typed the
// title first. The prefill was real, tested, and never fired for anyone
// following the form's own order.
//
// The other half is the slug. It is derived, it is locked after creation, and
// it is NOT in the student's invitation link (that is `/:org/i/:token`). It
// does name three real things - `assignments/<id>.yml`, the public
// `broker-<id>` repository a student lands on to accept, and the lecturer's own
// `/dashboard/<org>/<id>` - so it is shown rather than hidden. Shown as a
// consequence of the title, not as a box asking a question.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const TEMPLATE = 'linux-processes-starter';

const REPOS = [
  { name: TEMPLATE, full_name: `${ORG}/${TEMPLATE}`, is_template: true, private: true, default_branch: 'main' },
  { name: 'ansible-lab-starter', full_name: `${ORG}/ansible-lab-starter`, is_template: true, private: true, default_branch: 'main' },
];

async function openNew(page, { assignments = {} } = {}) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments, roster: [], contentWrites });
  await page.route(/\/search\/repositories/, (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ total_count: REPOS.length, items: REPOS }),
  }));
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('.new-btn').click();
  await expect(page.locator('fieldset').first()).toBeVisible({ timeout: 15000 });
  return { contentWrites };
}

/** Pick the template the way a lecturer does: type, then click the match. */
async function pickTemplate(page) {
  const combo = page.getByPlaceholder('Type or select a template repository');
  await combo.click();
  await combo.fill('linux');
  await page.locator('.combobox-item').first().click();
}

const basics = (page) => page.locator('fieldset').first();
const slugField = (page) => page.locator('.field:has(.derived-line)');

test.describe('67 - one block, in the order the data flows', () => {
  test('Template and Basics are ONE fieldset now', async ({ page }) => {
    await openNew(page);
    const legends = await page.locator('fieldset legend').allTextContents();
    expect(legends).toEqual(['Basics', 'Assignment Type', 'Schedule', 'Guardrails']);
    // A border around each half of one question is the box prison DESIGN.md 1.1
    // names, and "what is this assignment called" and "what does it copy" are
    // one question.
    expect(legends).not.toContain('Template');
  });

  test('THE ORDER: template, title, pattern, slug, description', async ({ page }) => {
    await openNew(page);
    // Read out of the DOM rather than asserted one at a time, so a field moved
    // into the wrong place fails here rather than passing four separate
    // assertions about fields that happen to exist.
    const labels = (await basics(page).locator('.field > label, .derived-line > span').allTextContents())
      .map((t) => t.replace(/\s*\*\s*$/, '').trim());
    expect(labels).toEqual([
      'Template repository',
      'Title',
      'Repository name pattern',
      'Slug',
      'Description',
    ]);
  });

  test('picking the template fills the title, the pattern and the slug', async ({ page }) => {
    // HONEST ABOUT WHAT THIS GUARDS. It is not the guard for the reorder: it
    // touches the template first, so it would have passed against the old
    // layout too - the prefill was always correct, it was just unreachable for
    // anyone filling the form in the order the form itself presented. What
    // makes it reachable is the ORDER, and the test above is what pins that.
    // This one pins that moving the fields did not break the chain behind them.
    await openNew(page);
    await pickTemplate(page);

    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Linux Processes Starter');
    await expect(page.getByPlaceholder('linux-processes-{github_login}'))
      .toHaveValue(`${TEMPLATE}-{github_login}`);
    await expect(slugField(page)).toContainText(TEMPLATE);
  });

  test('a title already typed is never stamped on by the template', async ({ page }) => {
    // The reason the prefill is conditional in the first place. Reordering the
    // form must not turn "fill the empty box" into "overwrite my work".
    await openNew(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Resit, January');
    await pickTemplate(page);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Resit, January');
  });

  test('the slug is a statement, not a question - until you ask for it', async ({ page }) => {
    await openNew(page);
    await pickTemplate(page);

    // No input on screen: the value and a way in.
    await expect(page.getByPlaceholder('linux-processes-2026')).toHaveCount(0);
    await expect(slugField(page)).toContainText(TEMPLATE);

    await slugField(page).getByRole('button', { name: 'Edit' }).click();
    const input = page.getByPlaceholder('linux-processes-2026');
    await expect(input).toHaveValue(TEMPLATE);

    // And overriding it still re-derives the pattern, which is the reason
    // anybody would open it.
    await input.fill('linux-2027');
    await expect(page.getByPlaceholder('linux-processes-{github_login}'))
      .toHaveValue('linux-2027-{github_login}');
  });

  test('on an existing assignment the slug is a reading with no way in', async ({ page }) => {
    // Changing it orphans assignments/<id>.yml. It used to be a disabled box,
    // which said the same thing while still looking like somewhere a value
    // goes.
    await openNew(page, {
      assignments: {
        'lab-3': {
          schema_version: 1, id: 'lab-3', title: 'Lab 3', organization: ORG,
          template: { owner: ORG, repository: TEMPLATE },
          repository_name_pattern: 'lab-3-{github_login}',
          opens_at: '2026-09-01T08:00:00Z', deadline_at: '2026-12-30T20:00:00Z',
          state: 'draft', assignment_type: 'individual', roster_mode: 'enforced',
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=lab-3`);
    await expect(slugField(page)).toContainText('lab-3');
    await expect(slugField(page).getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByPlaceholder('linux-processes-2026')).toHaveCount(0);
  });

  test('the collision check runs on the fast path, before Save', async ({ page }) => {
    // Pick a template, watch everything derive, press Save - and nothing was
    // ever blurred, so the courtesy check that lives on blur never ran. The
    // gate on save still refuses, but by then changing the title is no longer
    // free. `selectTemplate` triggers it once the derived fields exist.
    let asked = 0;
    await openNew(page);
    await page.route(/\/orgs\/[^/]+\/repos\?/, (r) => { asked += 1; return r.continue(); });
    await pickTemplate(page);
    await expect.poll(() => asked, { timeout: 10000 }).toBeGreaterThan(0);
  });
});
