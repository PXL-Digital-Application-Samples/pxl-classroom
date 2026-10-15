// The README's screenshots, from a fictional course on the mocked GitHub.
// See playwright.shots.config.mjs for how to run it.
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inviteUrl, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import * as demo from './demo-course.mjs';
import { WHATS_NEW_VERSION } from '../../frontend/src/lib/whats-new.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.SHOTS_OUT || join(root, 'assets', 'images');
mkdirSync(OUT, { recursive: true });

const PALETTE = ['#2f81f7', '#a371f7', '#3fb950', '#d29922', '#db61a2', '#f78166'];

/** An avatar drawn from initials: the fictional accounts have no picture. */
function avatarSvg(seed, label) {
  const color = PALETTE[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">`
    + `<rect width="96" height="96" fill="${color}"/>`
    + `<text x="48" y="60" font-family="Segoe UI, Arial, sans-serif" font-size="40" font-weight="600" fill="#fff" text-anchor="middle">${label}</text></svg>`;
}

const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** Signed in as `user`, in the dark theme, with drawn avatars. */
async function prepare(page, user) {
  const auth = JSON.stringify({
    access_token: user.token,
    user: { login: user.login, id: user.id, name: user.name, avatar_url: `https://avatars.githubusercontent.com/u/${user.id}` },
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  await page.addInitScript(({ data, seen }) => {
    localStorage.setItem('pxl_auth', data);
    localStorage.setItem('pxl_theme', 'dark');
    // The one-time "This page changed." notice, as already read.
    localStorage.setItem('pxl_seen_new_look', seen);
  }, { data: auth, seen: WHATS_NEW_VERSION });
  const names = new Map([[String(user.id), user.name], ...demo.STUDENTS.map((s) => [String(s.id), s.full_name])]);
  await page.route('**/avatars.githubusercontent.com/**', (route) => {
    const id = /\/u\/(\d+)/.exec(route.request().url())?.[1] ?? 'x';
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: avatarSvg(id, initials(names.get(id) ?? '?')) });
  });
}

const lecturerData = {
  org: demo.ORG,
  participatingOrgs: [{ login: demo.ORG, name: demo.ORG }],
  currentUser: demo.LECTURER,
  assignments: demo.ASSIGNMENTS,
  allOrgAssignments: { [demo.ORG]: demo.ASSIGNMENTS },
  reports: demo.REPORTS,
  gradingSummaries: demo.GRADING,
  controlTeams: demo.CONTROL_TEAMS,
  roster: demo.ROSTER,
  usageReports: { [demo.ORG]: demo.USAGE },
};

async function asLecturer(page, path) {
  await prepare(page, demo.LECTURER);
  await setupStandardMockRoutes(page, lecturerData);
  await page.goto(path);
}

/**
 * The page cropped to what is on it: from the top bar down to the bottom of
 * the content, between the content's left and right edges, with a margin -
 * and no taller than `maxHeight` CSS pixels, for a table that goes on.
 */
async function shot(page, name, { maxHeight = Infinity, margin = 24, selector = null } = {}) {
  await page.waitForLoadState('networkidle');
  // Fonts, avatars and transitions settled.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  if (selector) {
    // One block on its own, without the top bar.
    const b = await page.locator(selector).first().boundingBox();
    const clip = { x: Math.max(0, b.x - margin), y: Math.max(0, b.y - margin), width: b.width + 2 * margin, height: b.height + 2 * margin };
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, clip });
    return;
  }
  const box = await page.evaluate((cap) => {
    const vw = document.documentElement.clientWidth;
    let left = Infinity, right = -Infinity, bottom = 0, lowest = '';
    // What draws something - text, a control, an image, a box with a border -
    // and not the layout containers around it, which can reach the window's
    // bottom (`min-height: 100vh`) with nothing in them.
    const draws = (el, style) => {
      if (el.matches('img, svg, input, select, textarea, button, table, canvas')) return true;
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return true;
      return parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderBottomWidth) > 0 && el.getBoundingClientRect().height < window.innerHeight;
    };
    // Only the part that shows: a table inside a scrolling box goes on below
    // it, hidden. Clipped to every ancestor that clips.
    const visibleRect = (el) => {
      const b = el.getBoundingClientRect();
      let { left, right, top, bottom } = b;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY + s.overflowX)) {
          const ar = a.getBoundingClientRect();
          left = Math.max(left, ar.left); right = Math.min(right, ar.right);
          top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom);
        }
      }
      return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    };
    for (const el of document.querySelectorAll('#app *')) {
      const r = visibleRect(el);
      const style = getComputedStyle(el);
      // A screen-reader-only element is a 1px box somewhere; it draws nothing.
      if (r.width < 2 || r.height < 2 || r.width >= vw - 1 || style.visibility === 'hidden' || style.display === 'contents' || style.opacity === '0') continue;
      if (!draws(el, style)) continue;
      left = Math.min(left, r.left + window.scrollX);
      right = Math.max(right, r.right + window.scrollX);
      if (r.bottom + window.scrollY > bottom) {
        bottom = r.bottom + window.scrollY;
        lowest = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
      }
    }
    // Capped: end on the last table row that fits whole, not through one.
    let cut = null;
    if (bottom > cap) {
      for (const tr of document.querySelectorAll('#app tr')) {
        const b = tr.getBoundingClientRect().bottom + window.scrollY;
        if (b <= cap && (cut === null || b > cut)) cut = b;
      }
    }
    return { left, right, bottom, vw, lowest, cut };
  }, maxHeight);
  if (process.env.SHOTS_DEBUG) console.log(name, JSON.stringify(box));
  const x = Math.max(0, Math.floor(box.left - margin));
  const width = Math.min(box.vw, Math.ceil(box.right + margin)) - x;
  const height = box.cut !== null ? Math.ceil(box.cut) : Math.min(Math.ceil(box.bottom + margin), maxHeight);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, clip: { x, y: 0, width, height } });
}

test('organization overview', async ({ page }) => {
  await asLecturer(page, `/dashboard/${demo.ORG}`);
  await expect(page.getByText('Lab 3: Docker networking').first()).toBeVisible({ timeout: 20000 });
  await shot(page, 'readme-overview');
});

test('progress tab', async ({ page }) => {
  await asLecturer(page, `/dashboard/${demo.ORG}/${demo.IDS.LAB}`);
  await expect(page.getByRole('link', { name: 'demo-alice' }).first()).toBeVisible({ timeout: 20000 });
  await shot(page, 'readme-progress', { maxHeight: 980 });
});

test('grading tab', async ({ page }) => {
  await asLecturer(page, `/dashboard/${demo.ORG}/${demo.IDS.EXAM}?tab=grading`);
  await expect(page.locator('[data-grading-table]')).toBeVisible({ timeout: 20000 });
  await shot(page, 'readme-grading', { maxHeight: 1120 });
});

test('teams tab', async ({ page }) => {
  await asLecturer(page, `/dashboard/${demo.ORG}/${demo.IDS.PROJECT}?tab=teams`);
  await expect(page.getByText('Cloud Nine').first()).toBeVisible({ timeout: 20000 });
  await shot(page, 'readme-teams');
});

test('roster', async ({ page }) => {
  await asLecturer(page, `/dashboard/${demo.ORG}/roster`);
  await expect(page.getByText(demo.STUDENTS[0].full_name).first()).toBeVisible({ timeout: 20000 });
  await shot(page, 'readme-roster');
});

test('new assignment form', async ({ page }) => {
  await prepare(page, demo.LECTURER);
  await setupStandardMockRoutes(page, lecturerData);
  // The org's template repositories, as GitHub's search lists them. One, so
  // the form picks it by itself, as it does for a course with one template.
  const template = { name: 'lab-5-helm-template', full_name: `${demo.ORG}/lab-5-helm-template`, is_template: true, fork: false, private: true, default_branch: 'main' };
  await page.route('**/search/repositories*', (route) => route.fulfill({ status: 200, body: JSON.stringify({ total_count: 1, items: [template] }) }));
  await page.goto(`/dashboard/${demo.ORG}/new`);
  const title = page.getByPlaceholder('e.g. Linux Processes 2026');
  await expect(title).toBeVisible({ timeout: 20000 });
  await title.fill('Lab 5: Helm charts');
  await title.blur();
  // The top of the form, as it opens: the window, not the whole page.
  await shot(page, 'readme-new-assignment', { maxHeight: 900 });
});

test('student assignment page', async ({ page }) => {
  await prepare(page, demo.STUDENT);
  await setupStandardMockRoutes(page, {
    org: demo.ORG,
    participatingOrgs: [{ login: demo.ORG, name: demo.ORG }],
    currentUser: demo.STUDENT,
    assignments: demo.ASSIGNMENTS,
    userRepos: [{
      name: `${demo.IDS.LAB}-${demo.STUDENT.login}`,
      full_name: `${demo.ORG}/${demo.IDS.LAB}-${demo.STUDENT.login}`,
      html_url: `https://github.com/${demo.ORG}/${demo.IDS.LAB}-${demo.STUDENT.login}`,
      pushed_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      permissions: { admin: true, push: true, pull: true },
    }],
  });
  await page.goto(inviteUrl(demo.ORG, demo.IDS.LAB));
  await expect(page.locator('a.repo-link')).toBeVisible({ timeout: 20000 });
  await shot(page, 'readme-student');
});

test('connect an organization', async ({ page }) => {
  await prepare(page, demo.LECTURER);
  await setupStandardMockRoutes(page, { ...lecturerData, participatingOrgs: [] });
  await page.goto('/dashboard');
  await expect(page.getByRole('button', { name: /Connect an organization/ }).or(page.getByRole('link', { name: /Connect an organization/ })).first()).toBeVisible({ timeout: 20000 });
  await shot(page, 'readme-connect-org', { selector: '.center-card' });
});
