import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, inviteToken, expandSettings } from '../fixtures/e2e-fixtures.mjs';

// Reported live: narrowing the window pushed the heading and cards flush to the
// left edge with no gutter, and the page scrolled sideways. Two causes:
//
//   main { padding: var(--space-xl) 0 }  - `main` is an ELEMENT selector inside
//     a scoped block, so it carries the component attribute and out-specifies
//     .container. The shorthand therefore wiped .container's horizontal padding
//     at every width; content only looked inset above the 1240px max-width,
//     where margin:auto happened to create the gap.
//
//   .org-dropdown-container { min-width: 200px } - a hard floor in the header,
//     so the bar could not fit a narrow viewport and forced a sideways scroll.
//
// Neither is visible at desktop width, which is why nothing caught them.

const WIDTHS = [1280, 900, 700, 560, 480, 390, 360];
// The gutter is fluid (--gutter: clamp(12px, 1.6vw, 24px)), so the floor is the
// clamp minimum, not the desktop value. Asserting 24 here would pin the
// desktop number and fail every narrow width by design.
const MIN_GUTTER = 12;

/** Leftmost gutter of the page's own content, and any sideways overflow. */
const MEASURE = () => {
  const de = document.documentElement;
  const vw = window.innerWidth;

  const overflowing = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1) {
      overflowing.push(
        `${el.tagName.toLowerCase()}${el.className ? '.' + el.className.toString().trim().split(/\s+/).slice(0, 2).join('.') : ''}` +
        ` (right=${Math.round(r.right)} > ${vw})`,
      );
    }
  }

  // The main content block: whatever .container renders inside <main>.
  const main = document.querySelector('main.container') || document.querySelector('main');
  const block = main?.querySelector(':scope > div, :scope > section');
  const br = block?.getBoundingClientRect();

  return {
    scrollsSideways: de.scrollWidth > vw + 1,
    overflowing: overflowing.slice(0, 4),
    contentLeft: br ? Math.round(br.left) : null,
    contentRight: br ? Math.round(vw - br.right) : null,
  };
};

test.describe('25 - Responsive layout', () => {
  // The route sweep below only ever visited the admin panel with NOTHING open,
  // where the editor pane is a two-line empty state - so the pane that holds
  // the entire assignment form was never measured at any width. It scrolled
  // 208px sideways on a phone: `.admin-layout` used a bare `1fr`, whose
  // automatic minimum is its content's min-content size, and the invitation
  // link is `white-space: nowrap`, so its min-content IS a 122-character URL.
  // The track grew to fit it. `minmax(0, 1fr)` is the floor that stops it.
  test('No sideways scroll in the admin editor, open and closed, at every width', async ({ page }) => {
    const ID = 'linux-processes-2026';
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        [ID]: {
          schema_version: 1,
          id: ID,
          title: 'Linux Processes 2026',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          roster_mode: 'enforced',
          max_acceptances: 150,
          opens_at: new Date(Date.now() - 86400000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000).toISOString(),
          template: { owner: ORG, repository: 'linux-template' },
          repository_name_pattern: `${ID}-{github_login}`,
          // Without a token the share block never renders its link, which is
          // the element that caused this.
          invite_token: inviteToken(ORG, ID),
          invite_nonce: '0badc0de',
        },
      },
      userRepos: [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}` }],
    });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
      await expect(page.locator('.cohort-card')).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(500);

      let m = await page.evaluate(MEASURE);
      expect(
        m.scrollsSideways,
        `admin editor (collapsed) @${width}px scrolls sideways. Overflowing: ${m.overflowing.join(', ') || 'unknown'}`,
      ).toBe(false);

      // And with the six fieldsets on screen, which is where the combobox,
      // the datetime inputs and the autograde summary live.
      await expandSettings(page);
      await page.waitForTimeout(300);
      m = await page.evaluate(MEASURE);
      expect(
        m.scrollsSideways,
        `admin editor (settings open) @${width}px scrolls sideways. Overflowing: ${m.overflowing.join(', ') || 'unknown'}`,
      ).toBe(false);
    }
  });

  // The per-assignment views were never in the loop below, and the Teams tab's
  // data table wrapper (.table-responsive) turned out to be declared nowhere -
  // ~200px of sideways scroll on a phone, invisible at desktop width.
  test('No sideways scroll on the group assignment detail view, in either tab', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        g: {
          id: 'g',
          title: 'Group Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          repository_name_pattern: 'g-{team_slug}',
          deadline_at: '2099-01-01T00:00:00Z',
          group_config: { max_team_size: 3 },
        },
      },
      reports: {
        g: {
          schema_version: 1,
          assignment_id: 'g',
          org: ORG,
          generated_at: new Date().toISOString(),
          students: [
            { github_login: 'student-one', acceptance_state: 'accepted', team_slug: 'team-alpha', submission_status: 'on-time' },
          ],
          teams: [
            {
              team_slug: 'team-alpha',
              team_name: 'Team Alpha With A Long Name',
              members: ['student-one', 'student-two', 'student-three'],
              repo_name: `${ORG}/g-team-alpha`,
              repo_url: `https://github.com/${ORG}/g-team-alpha`,
              submission_status: 'on-time',
              commit_count: 12,
            },
          ],
        },
      },
    });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/dashboard/${ORG}/g`);
      await page.waitForTimeout(700);

      const students = await page.evaluate(MEASURE);
      expect(students.scrollsSideways, `students view at ${width}px: ${students.overflowing.join(', ')}`).toBe(false);

      await page.locator('.tab-pill', { hasText: /Teams View/i }).click();
      await page.waitForTimeout(300);

      const teams = await page.evaluate(MEASURE);
      expect(teams.scrollsSideways, `teams view at ${width}px: ${teams.overflowing.join(', ')}`).toBe(false);
    }
  });

  for (const route of ['/', `/dashboard/${ORG}`, `/dashboard/${ORG}/usage`, '/usage']) {
    test(`No sideways scroll and a real gutter at every width: ${route}`, async ({ page }) => {
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, { currentUser: LECTURER });

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        await page.waitForTimeout(900);

        const m = await page.evaluate(MEASURE);

        expect(
          m.scrollsSideways,
          `${route} @${width}px scrolls sideways. Overflowing: ${m.overflowing.join(', ') || 'unknown'}`,
        ).toBe(false);

        if (m.contentLeft !== null) {
          expect(
            m.contentLeft,
            `${route} @${width}px: content sits ${m.contentLeft}px from the left edge. ` +
              'A scoped `main { padding: X 0 }` out-specifies .container and removes its gutter.',
          ).toBeGreaterThanOrEqual(MIN_GUTTER);
        }
      }
    });
  }

  test('The gutter scales with the window instead of sitting at the desktop value', async ({ page }) => {
    // Reported live: a fixed 24px gutter is fine full-screen but reads as wasted
    // space in a window snapped to half a desktop screen - which is still
    // "desktop" to any breakpoint, so a step at 640px never reached it.
    // --gutter is clamp(12px, 1.6vw, 24px); this asserts the ramp exists.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });

    const gutterAt = async (width) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/dashboard/${ORG}`);
      await page.waitForTimeout(600);
      return page.evaluate(() => {
        const main = document.querySelector('main.container');
        return main ? parseFloat(getComputedStyle(main).paddingLeft) : NaN;
      });
    };

    const wide = await gutterAt(1920);
    const half = await gutterAt(960);
    const phone = await gutterAt(390);

    expect(wide, 'a wide window should get the full desktop gutter').toBeGreaterThanOrEqual(24);
    expect(half, 'a half-screen window should get less than the desktop gutter').toBeLessThan(wide - 4);
    expect(phone, 'a phone should get less again').toBeLessThan(half);
    expect(phone, 'but never zero - flush-left content was the original bug').toBeGreaterThanOrEqual(MIN_GUTTER);
  });

  test('The header itself never forces a horizontal scrollbar', async ({ page }) => {
    // A long org name plus the brand, separator and "Lecturer" tag exceeded a
    // phone-width viewport while the dropdown had a 200px floor.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });

    for (const width of [420, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/dashboard/${ORG}`);
      await page.waitForTimeout(700);

      const over = await page.evaluate(() => {
        const vw = window.innerWidth;
        const out = [];
        for (const el of document.querySelectorAll('header.app-header *')) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > vw + 1) {
            out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/)[0]}`);
          }
        }
        return out;
      });
      expect(over, `header overflows at ${width}px`).toEqual([]);
    }
  });
});
