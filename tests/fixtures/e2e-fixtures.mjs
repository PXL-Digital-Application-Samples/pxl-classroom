import { expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { MANIFEST_APP_PERMISSIONS } from '../../lib/audit.mjs';
import { signInviteToken, generateKeyPair, inviteFileFor } from '../../lib/invite-token.mjs'

// Auto-load .env.test if present
if (existsSync('.env.test')) {
  try {
    process.loadEnvFile('.env.test');
  } catch {}
}

export const ORG = process.env.TEST_ORG || 'PXL-2TIN-CloudEssentials-2627';
export const ASSIGNMENT_ID = process.env.TEST_ASSIGNMENT_ID || 'test-groepsopdracht-2';

export const LECTURER = {
  login: process.env.TEST_LECTURER_LOGIN || 'tomcoolpxl-lecturer1',
  name: 'Lecturer One',
  token: process.env.TEST_LECTURER_TOKEN || 'mock_lecturer_token',
};

export const LECTURER_2 = {
  login: process.env.TEST_LECTURER2_LOGIN || 'tomcoolpxl-lecturer2',
  name: 'Lecturer Two',
  token: process.env.TEST_LECTURER2_TOKEN || 'mock_lecturer2_token',
};

export const STUDENT_1 = {
  login: process.env.TEST_STUDENT1_LOGIN || 'tomcoolpxl-student1',
  name: 'Student One',
  token: process.env.TEST_STUDENT1_TOKEN || 'mock_student1_token',
};

export const STUDENT_2 = {
  login: process.env.TEST_STUDENT2_LOGIN || 'tomcoolpxl-student2',
  name: 'Student Two',
  token: process.env.TEST_STUDENT2_TOKEN || 'mock_student2_token',
};

/**
 * Injects authentication into browser sessionStorage before page loads.
 */
// Student pages are reached by invitation token, not by assignment id
// (ARCHITECTURE §4.3.2). The SPA never verifies the signature - it only matches
// the token's subject against the org's published assignments - so a throwaway
// keypair is enough here, and the specs stay independent of the real signing
// key. One pair per run keeps every token in a spec file mutually consistent.
const E2E_KEYPAIR = generateKeyPair()

// digest -> assignment id, per org. Built lazily, shared across the run.
const digestIndex = new Map()

// Fixed, not Date.now()-derived. Expiry is encoded at MINUTE granularity, so a
// clock-based value makes inviteToken() impure: the spec's call and the route
// mock's call landing either side of a minute boundary mint different tokens,
// different digests, and a 404 for the acceptance card. That failed roughly one
// run in four.
const E2E_TOKEN_EXPIRY = '2099-01-01T00:00:00.000Z'

export function inviteToken(org, assignmentId) {
  return signInviteToken({
    org,
    assignmentId,
    expiresAt: E2E_TOKEN_EXPIRY,
    nonce: 'e2e00001',
    privateKeyPem: E2E_KEYPAIR.privateKeyPem,
  })
}

/** The student-facing URL for an assignment, as a lecturer would hand it out. */
export function inviteUrl(org, assignmentId) {
  return `/${org}/i/${inviteToken(org, assignmentId)}`
}

/**
 * Expand the Admin Panel's "Edit settings" disclosure and wait for the form.
 *
 * A published or closed assignment opens on its cohort, with the six
 * fieldsets collapsed (UX_PLAN §7.1). A draft renders them directly - there
 * the summary is `display: none` and the <details> is already open, so this is
 * a no-op that still waits for the form. One implementation, because every
 * spec that edits an assignment needs the same three lines.
 */
export async function expandSettings(page) {
  const details = page.locator('details.settings-disclosure');
  await details.waitFor({ state: 'attached', timeout: 15000 });
  if (!(await details.evaluate((el) => el.open))) {
    await details.locator('> summary').click();
  }
  await page.getByPlaceholder('e.g. Linux Processes 2026')
    .waitFor({ state: 'visible', timeout: 10000 });
}

export async function injectAuth(page, user) {
  const authData = JSON.stringify({
    access_token: user.token,
    user: { login: user.login, name: user.name, email: user.email },
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });

  await page.addInitScript(({ data }) => {
    sessionStorage.setItem('pxl_auth', data);
  }, { data: authData });
}

/**
 * Standard route interceptor for deterministic frontend testing.
 */
export async function setupStandardMockRoutes(page, {
  org = ORG,
  participatingOrgs = [{ login: ORG, name: ORG }],
  assignments = {},
  allOrgAssignments = {},
  teams = {},
  reports = {},
  usageReports = {},
  currentUser = STUDENT_2,
  userRepos = [],
  invitations = [],
  brokerIssues = [],
  roster = null,
  // Team manifests as they exist in the CONTROL repo (teams/<id>/<slug>.json),
  // as opposed to `teams`, which is the generated public Pages payload.
  controlTeams = {},
  // Caller-owned sinks. The fixture pushes one entry per Git Data API commit
  // ({ message, files: [{ path, content }] }) and per workflow_dispatch
  // ({ workflow, inputs }), so a spec can assert what was actually written.
  gitCommits = [],
  workflowDispatches = [],
  // Contents API writes ({ path, content, message }), one per commitFile().
  // gitCommits covers the Git Data API path; this covers the single-file one,
  // which is how the Admin Panel writes an assignment, a roster or an override.
  // A spec can then run the real backend module over the exact bytes the SPA
  // produced - the seam where the deadline-extension bug lived for two months.
  contentWrites = [],
  // Lecturer overrides already in the control repo, as
  // { '<assignment-id>': { '<login>': <override doc> } }. Anything the SPA
  // commits during the run is layered on top, so an append reads back what
  // was there.
  controlOverrides = {},
  // What GET /apps/{slug} reports the App declares. Defaults to a healthy App;
  // drop a key to reproduce an App that predates a manifest permission.
  appPermissions = { ...MANIFEST_APP_PERMISSIONS },
  // Left undefined by default so the installation mock keeps the shape every
  // existing spec was written against.
  installationPermissions = undefined,
  // "selected" reproduces an install scoped to a repository list, which cannot
  // see student repos created after the fact.
  installationRepositorySelection = undefined,
} = {}) {
  // Schema route mock
  await page.route('**/schemas/*.schema.json*', async (route) => {
    const url = route.request().url();
    const match = url.match(/schemas\/([^/?#]+\.schema\.json)/);
    const schemaFile = match ? match[1] : null;
    if (schemaFile) {
      const filePath = join(process.cwd(), 'schemas', schemaFile);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf8');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: content,
        });
        return;
      }
    }
    await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not found' }) });
  });

  // Multi-org index.json
  await page.route(`**/data/index.json*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schema_version: 1,
        generated_at: new Date().toISOString(),
        orgs: participatingOrgs,
      }),
    });
  });

  // In-memory dynamic files committed during the test session
  const dynamicFiles = new Map();
  const gitBlobs = new Map();
  let pendingTree = [];
  for (const [asgnId, list] of Object.entries(controlTeams)) {
    for (const team of list) {
      dynamicFiles.set(`teams/${asgnId}/${team.team_slug}.json`, JSON.stringify(team, null, 2));
    }
  }
  if (roster) {
    const yamlContent = typeof roster === 'string' ? roster : yamlStringify({ students: roster });
    dynamicFiles.set('students/roster.yml', yamlContent);
  }

  // Assignments JSON per org
  await page.route(`**/data/*/assignments.json*`, async (route) => {
    const url = route.request().url();
    const match = url.match(/data\/([^/?#]+)\/assignments\.json/);
    const requestedOrg = match ? match[1] : org;

    const orgAssignmentMap = allOrgAssignments[requestedOrg] || (requestedOrg === org ? assignments : {});
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schema_version: 1,
        generated_at: new Date().toISOString(),
        assignments: orgAssignmentMap,
      }),
    });
  });

  // Per-invitation Pages files. Named by the sha256 of the token, so the only
  // way to find one is to hold the link - the org-wide index above no longer
  // carries the acceptance card (ARCHITECTURE §4.3.3). The digest is matched
  // back to an assignment by re-deriving it, exactly as the generator does.
  await page.route(`**/data/*/i/*.json*`, async (route) => {
    const url = route.request().url();
    const match = url.match(/data\/([^/?#]+)\/i\/([0-9a-f]{64})(\.teams)?\.json/);
    if (!match) {
      await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not found' }) });
      return;
    }
    const [, requestedOrg, digest, isTeams] = match;
    const orgAssignmentMap =
      allOrgAssignments[requestedOrg] || (requestedOrg === org ? assignments : {});

    let asgnId = digestIndex.get(`${requestedOrg}/${digest}`) ?? null;
    if (asgnId === null) {
      // Signing is not free, and this route is hit on every navigation. Derive
      // the whole org's digests once, then answer from the map.
      for (const id of Object.keys(orgAssignmentMap)) {
        digestIndex.set(`${requestedOrg}/${inviteFileFor(inviteToken(requestedOrg, id))}`, id);
      }
      asgnId = digestIndex.get(`${requestedOrg}/${digest}`) ?? null;
    }
    if (!asgnId) {
      await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not found' }) });
      return;
    }

    const body = isTeams
      ? { schema_version: 1, assignment_id: asgnId, teams: teams[asgnId] || [] }
      : { schema_version: 1, assignment: { id: asgnId, ...orgAssignmentMap[asgnId] } };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  // Reports JSON per assignment
  await page.route(`**/data/${org}/reports/*.json*`, async (route) => {
    const url = route.request().url();
    const match = url.match(/reports\/([^/?#]+)\.json/);
    const asgnId = match ? match[1] : null;
    const reportData = asgnId && reports[asgnId] ? reports[asgnId] : null;

    if (reportData) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(reportData),
      });
    } else {
      await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not found' }) });
    }
  });

  // Teams JSON per assignment
  await page.route(`**/data/${org}/teams/*.json*`, async (route) => {
    const url = route.request().url();
    const match = url.match(/teams\/([^/?#]+)\.json/);
    const asgnId = match ? match[1] : null;
    const teamList = asgnId && teams[asgnId] ? teams[asgnId] : [];

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schema_version: 1,
        assignment_id: asgnId,
        teams: teamList,
      }),
    });
  });

  // GitHub API mocks
  await page.route('https://api.github.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.includes('repository_invitations') || url.includes('/invitations')) {
      if (method === 'PATCH' || method === 'DELETE') {
        await route.fulfill({ status: 204, body: '' });
      } else {
        await route.fulfill({ status: 200, body: JSON.stringify(invitations) });
      }
    } else if (url.includes('/apps/pxl-classroom-provisioner')) {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ slug: 'pxl-classroom-provisioner', permissions: appPermissions }),
      });
    } else if (url.includes('/user/installations')) {
      const isLecturerUser = currentUser.login.toLowerCase().includes('lecturer');
      const instList = isLecturerUser ? participatingOrgs.map((o) => ({
        id: 1000 + (typeof o === 'string' ? 1 : 2),
        account: { type: 'Organization', login: typeof o === 'string' ? o : o.login },
        ...(installationPermissions ? { permissions: installationPermissions } : {}),
        ...(installationRepositorySelection ? { repository_selection: installationRepositorySelection } : {}),
      })) : [];
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          total_count: instList.length,
          installations: instList,
        }),
      });
    } else if (url.includes('/user/repos')) {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(userRepos),
      });
    } else if (url.includes('/user/starred/')) {
      if (method === 'PUT' || method === 'DELETE') {
        await route.fulfill({ status: 204, body: '' });
      } else if (method === 'GET') {
        // Return 204 if starred, 404 otherwise
        await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
      }
    } else if (url.includes('/user')) {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ login: currentUser.login, id: 999999, name: currentUser.name, email: currentUser.email }),
      });
    } else if (url.includes('/issues') && url.includes('/comments') && method === 'POST') {
      await route.fulfill({
        status: 201,
        body: JSON.stringify({ id: 201, body: 'Comment posted' }),
      });
    } else if (url.includes('/issues') && method === 'GET') {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(brokerIssues),
      });
    } else if (url.includes('/issues') && method === 'POST') {
      await route.fulfill({
        status: 201,
        body: JSON.stringify({ id: 101, number: 1, state: 'open' }),
      });
    } else if (url.includes('/repos/')) {
      if (method === 'DELETE' && url.includes('/contents/')) {
        const match = url.match(/\/contents\/(.+)$/);
        const path = match ? decodeURIComponent(match[1]) : 'file';
        dynamicFiles.delete(path);
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            content: null,
            commit: { sha: 'delete_sha_123', message: 'Deleted by test' },
          }),
        });
        return;
      }

      // Git Data API - what commitFiles()/lib/gittree.mjs drives. Blob content
      // is remembered so the tree POST can record the real file bodies, and the
      // written paths land in dynamicFiles so a later contents GET sees them.
      if (url.includes('/git/')) {
        // gittree encodes the ref, so the URL carries /git/ref/heads%2Fmain
        if (method === 'GET' && url.includes('/git/ref/')) {
          await route.fulfill({ status: 200, body: JSON.stringify({ object: { sha: 'parent_commit_sha' } }) });
          return;
        }
        if (method === 'GET' && /\/git\/commits\//.test(url)) {
          await route.fulfill({
            status: 200,
            body: JSON.stringify({ sha: 'parent_commit_sha', tree: { sha: 'parent_tree_sha' } }),
          });
          return;
        }
        if (method === 'POST' && url.includes('/git/blobs')) {
          const body = route.request().postDataJSON();
          const sha = `blob_${gitBlobs.size + 1}`;
          gitBlobs.set(sha, Buffer.from(body.content || '', 'base64').toString('utf8'));
          await route.fulfill({ status: 201, body: JSON.stringify({ sha }) });
          return;
        }
        if (method === 'POST' && url.includes('/git/trees')) {
          const body = route.request().postDataJSON();
          pendingTree = (body.tree || []).map((entry) => ({
            path: entry.path,
            content: entry.sha === null ? null : gitBlobs.get(entry.sha) ?? null,
          }));
          for (const f of pendingTree) {
            if (f.content === null) dynamicFiles.delete(f.path);
            else dynamicFiles.set(f.path, f.content);
          }
          await route.fulfill({ status: 201, body: JSON.stringify({ sha: 'new_tree_sha' }) });
          return;
        }
        if (method === 'POST' && url.includes('/git/commits')) {
          const body = route.request().postDataJSON();
          gitCommits.push({ message: body.message, files: pendingTree });
          pendingTree = [];
          await route.fulfill({ status: 201, body: JSON.stringify({ sha: 'new_commit_sha' }) });
          return;
        }
        if (method === 'PATCH' && url.includes('/git/refs/')) {
          await route.fulfill({ status: 200, body: JSON.stringify({ object: { sha: 'new_commit_sha' } }) });
          return;
        }
      }

      if (url.includes('/collaborators/')) {
        if (method === 'PUT') {
          await route.fulfill({ status: 201, body: JSON.stringify({ id: 101, permissions: 'admin' }) });
          return;
        } else if (method === 'DELETE') {
          await route.fulfill({ status: 204, body: '' });
          return;
        }
      } else if (url.includes('/invitations')) {
        if (method === 'GET') {
          await route.fulfill({ status: 200, body: JSON.stringify([{ id: 888, invitee: { login: 'student-dev1' } }]) });
          return;
        } else if (method === 'DELETE') {
          await route.fulfill({ status: 204, body: '' });
          return;
        }
      }

      if (method === 'PUT' && url.includes('/contents/')) {
        const match = url.match(/\/contents\/(.+)$/);
        const path = match ? decodeURIComponent(match[1]) : 'file';
        try {
          const postData = route.request().postDataJSON();
          if (postData?.content) {
            const decoded = Buffer.from(postData.content, 'base64').toString('utf8');
            dynamicFiles.set(path, decoded);
            contentWrites.push({ path, content: decoded, message: postData.message });
          }
        } catch {}
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            content: { name: path, path, sha: 'commit_sha_123' },
            commit: { sha: 'commit_sha_123', message: 'Committed by test' },
          }),
        });
        return;
      }

      if (url.includes('/pxl-classroom-control/contents/reports/usage-latest.json')) {
        const orgMatch = url.match(/\/repos\/([^/]+)\/pxl-classroom-control/);
        const targetOrg = orgMatch ? orgMatch[1] : org;
        const usageData = usageReports[targetOrg] || {
          schema_version: 1,
          week_start: '2026-08-17',
          week_end: '2026-08-23',
          generated_at: new Date().toISOString(),
          over_count: 0,
          items: [
            { repo: 'lab-cloud-storage', sku: 'actions_minutes', used: 120, limit: 2000, over: false },
          ],
        };
        const contentBase64 = Buffer.from(JSON.stringify(usageData)).toString('base64');
        await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
        return;
      }

      if (url.includes('/pxl-classroom-control/contents/reports/')) {
        const match = url.match(/\/reports\/([^/?#]+)\.json/);
        const asgnId = match ? match[1] : null;
        const rep = asgnId && reports[asgnId] ? reports[asgnId] : null;
        if (rep) {
          const contentBase64 = Buffer.from(JSON.stringify(rep)).toString('base64');
          await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
          return;
        }
      } else if (url.includes('/pxl-classroom-control/contents/students/roster.yml') || url.includes('/pxl-classroom-control/contents/students/roster.yaml')) {
        const dynamicRoster = dynamicFiles.get('students/roster.yml') || dynamicFiles.get('students/roster.yaml');
        if (dynamicRoster) {
          const contentBase64 = Buffer.from(dynamicRoster).toString('base64');
          await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64', sha: 'roster_sha_1' }) });
          return;
        }
        await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
        return;
      } else if (/\/pxl-classroom-control\/contents\/teams\/[^/?#]+(\?|$)/.test(url)) {
        // Directory listing for teams/<assignment-id>
        const dirMatch = url.match(/\/contents\/teams\/([^/?#]+)/);
        const asgnId = dirMatch ? dirMatch[1] : null;
        const entries = [];
        for (const [path] of dynamicFiles.entries()) {
          if (!path.startsWith(`teams/${asgnId}/`) || !path.endsWith('.json')) continue;
          entries.push({ name: path.split('/').pop(), path, type: 'file' });
        }
        await route.fulfill({ status: 200, body: JSON.stringify(entries) });
        return;
      } else if (url.includes('/pxl-classroom-control/contents/teams/')) {
        const match = url.match(/\/contents\/teams\/([^/?#]+)\/([^/?#]+)\.json/);
        const asgnId = match ? match[1] : null;
        const slug = match ? match[2] : null;
        const dynamicContent = dynamicFiles.get(`teams/${asgnId}/${slug}.json`);
        if (dynamicContent) {
          const contentBase64 = Buffer.from(dynamicContent).toString('base64');
          await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64', sha: 'team_sha_123' }) });
          return;
        }
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            content: Buffer.from(JSON.stringify({ team_slug: slug, members: [] })).toString('base64'),
            encoding: 'base64',
            sha: 'team_sha_123',
          }),
        });
        return;
      } else if (url.includes('/pxl-classroom-control/contents/assignments')) {
        const match = url.match(/\/assignments\/([^/?#]+)\.ya?ml/);
        const asgnId = match ? match[1] : null;
        if (asgnId) {
          const dynamicContent = dynamicFiles.get(`assignments/${asgnId}.yml`) || dynamicFiles.get(`assignments/${asgnId}.yaml`);
          if (dynamicContent) {
            const contentBase64 = Buffer.from(dynamicContent).toString('base64');
            await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
            return;
          }
          if (assignments[asgnId]) {
            const yamlContent = yamlStringify(assignments[asgnId]);
            const contentBase64 = Buffer.from(yamlContent).toString('base64');
            await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
            return;
          }
          await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
          return;
        }

        // Directory listing for assignments/
        const fileList = [];
        for (const id of Object.keys(assignments)) {
          fileList.push({ name: `${id}.yml`, path: `assignments/${id}.yml`, type: 'file' });
        }
        for (const [path] of dynamicFiles.entries()) {
          if (path.startsWith('assignments/') && path.endsWith('.yml')) {
            const fname = path.replace('assignments/', '');
            if (!fileList.some((f) => f.name === fname)) {
              fileList.push({ name: fname, path, type: 'file' });
            }
          }
        }
        await route.fulfill({ status: 200, body: JSON.stringify(fileList) });
        return;
      } else if (url.includes('/pxl-classroom-control/contents/overrides/')) {
        const match = url.match(/\/overrides\/([^/?#]+)(?:\/([^/?#]+)\.json)?/);
        const asgnId = match ? match[1] : null;
        const login = match ? match[2] : null;
        // Caller-seeded overrides, plus anything the SPA has committed during
        // this run - so "grant a second extension" reads back the first, the
        // way it would against a real control repo.
        const seeded = controlOverrides?.[asgnId] ?? {};
        const written = new Map();
        for (const [p, content] of dynamicFiles.entries()) {
          const m = p.match(new RegExp(`^overrides/${asgnId}/([^/]+)\\.json$`));
          if (m) written.set(m[1], content);
        }
        if (Object.keys(seeded).length || written.size) {
          if (login) {
            const content = written.get(login) ?? (seeded[login] ? JSON.stringify(seeded[login]) : null);
            if (content === null) {
              await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
              return;
            }
            await route.fulfill({
              status: 200,
              body: JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
            });
            return;
          }
          const logins = new Set([...Object.keys(seeded), ...written.keys()]);
          await route.fulfill({
            status: 200,
            body: JSON.stringify([...logins].map((l) => ({
              name: `${l}.json`, path: `overrides/${asgnId}/${l}.json`, type: 'file',
            }))),
          });
          return;
        }
        if (asgnId === 'lab-extended') {
          if (login) {
            const overrideDoc = {
              schema_version: 1,
              assignment_id: 'lab-extended',
              github_login: 'student-extended',
              overrides: [
                {
                  type: 'deadline_extension',
                  value: new Date(Date.now() + 3600 * 1000 * 48).toISOString(),
                  reason: 'Approved medical extension (3 days)',
                  granted_at: new Date().toISOString(),
                  granted_by: 'lecturer',
                },
              ],
            };
            const contentBase64 = Buffer.from(JSON.stringify(overrideDoc)).toString('base64');
            await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
            return;
          } else {
            await route.fulfill({
              status: 200,
              body: JSON.stringify([
                { name: 'student-extended.json', path: 'overrides/lab-extended/student-extended.json', type: 'file' },
              ]),
            });
            return;
          }
        }
        await route.fulfill({ status: 200, body: JSON.stringify([]) });
        return;
      } else if (url.includes('/pxl-classroom-control/contents/assignments.yml') || url.includes('/pxl-classroom-control/contents/roster.yml')) {
        await route.fulfill({ status: 200, body: JSON.stringify({ content: '', encoding: 'base64' }) });
      } else if (url.includes('/actions/workflows/') && url.includes('/dispatches')) {
        const wf = url.match(/\/workflows\/([^/]+)\/dispatches/);
        let inputs = null;
        try { inputs = route.request().postDataJSON()?.inputs ?? null; } catch {}
        workflowDispatches.push({ workflow: wf ? decodeURIComponent(wf[1]) : null, inputs });
        await route.fulfill({ status: 204, body: '' });
        return;
      } else if (url.includes('/compare/')) {
        // Compare API for pre-flight scan
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            status: 'behind',
            ahead_by: 0,
            behind_by: 1,
            total_commits: 1,
            files: [],
          }),
        });
        return;
      } else if (url.includes('/commits/') && !url.includes('/check-runs')) {
        // Commit detail with changed files
        const sha = url.split('/commits/')[1]?.split('?')[0] || 'mocksha';
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            sha,
            commit: {
              message: 'docs: update lab instructions in README.md and add validation tests',
              author: { name: 'Lecturer Alice', date: new Date().toISOString() },
            },
            files: [
              {
                filename: 'README.md',
                status: 'modified',
                additions: 15,
                deletions: 3,
                patch: '@@ -10,7 +10,12 @@\n-Old instructions from 2025\n+Updated Assignment Guidelines for 2026\n+Ensure all tests in tests/ pass before deadline',
              },
              {
                filename: 'tests/test_validation.py',
                status: 'added',
                additions: 35,
                deletions: 0,
                patch: '@@ -0,0 +1,35 @@\n+import unittest\n+class TestValidation(unittest.TestCase):\n+    def test_run(self):\n+        self.assertTrue(True)',
              },
              {
                filename: 'config.json',
                status: 'modified',
                additions: 4,
                deletions: 1,
                patch: '@@ -1,4 +1,7 @@\n-{\n-  "env": "dev"\n-}\n+{\n+  "env": "prod",\n+  "strict": true\n+}',
              },
            ],
          }),
        });
        return;
      } else if (url.includes('/commits') && !url.includes('/check-runs')) {
        if (url.includes('lab-unstarted')) {
          await route.fulfill({ status: 200, body: JSON.stringify([]) });
          return;
        }
        if (url.includes('lab-late-student')) {
          await route.fulfill({
            status: 200,
            body: JSON.stringify([
              {
                sha: 'deadbeef99999999999999999999999999999999',
                commit: {
                  message: 'feat: submitted late work',
                  author: { name: 'Late Student', date: new Date(Date.now() - 3600 * 1000 * 2).toISOString() },
                },
              },
            ]),
          });
          return;
        }
        // Commits list
        await route.fulfill({
          status: 200,
          body: JSON.stringify([
            {
              sha: 'c0ffee1234567890abcdef1234567890abcdef12',
              commit: {
                message: 'docs: update lab instructions in README.md and add validation tests',
                author: { name: 'Lecturer Alice', date: new Date(Date.now() - 3600 * 1000 * 48).toISOString() },
              },
            },
          ]),
        });
        return;
      }

      const match = url.match(/\/repos\/([^/]+)\/([^/?#]+)/);
      const targetRepo = match ? `${match[1]}/${match[2]}` : '';
      const existing = userRepos.find((r) => r.full_name === targetRepo || r.name === match?.[2]);
      if (existing) {
        await route.fulfill({ status: 200, body: JSON.stringify(existing) });
      } else if (match?.[2] === 'pxl-classroom-control') {
        await route.fulfill({ status: 200, body: JSON.stringify({ full_name: `${match[1]}/pxl-classroom-control`, name: 'pxl-classroom-control' }) });
      } else if (match?.[2]?.includes('template')) {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            full_name: `${match[1]}/${match[2]}`,
            name: match[2],
            is_template: !match[2].includes('non-template'),
            default_branch: 'main',
            private: false,
          }),
        });
      } else {
        await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
      }
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify({}) });
    }
  });
}

// The Primer overhaul moved secondary and maintenance actions out of the header
// toolbar into the "More" dropdown, so they are menu items rather than buttons.
// Check aria-expanded before clicking: a blind toggle closes an open menu.
export async function openMoreActionsMenu(page) {
  const trigger = page.locator('button[aria-haspopup="true"]:has(span:text-is("More"))');
  await expect(trigger).toBeVisible({ timeout: 10000 });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
  await expect(page.locator('[role="menu"]').first()).toBeVisible();
}

// Automated checks moved out of the Guardrails fieldset into a modal
// (UX_PLAN §6). The form shows one summary line; everything else is behind it.
export async function openAutogradeModal(page) {
  await page.locator('.autograde-summary-row button', { hasText: /^(Set up|Edit)$/ }).click();
  await expect(page.locator('.autograde-setup-modal')).toBeVisible({ timeout: 10000 });
}

/** Add a check from its named preset - each arrives pre-filled and valid. */
export async function addCheck(page, label) {
  await page.locator('.ag-add button', { hasText: label }).click();
}

export const CHECK_RUN = 'A command that must succeed';
export const CHECK_IO = 'Compare output for given input';
export const CHECK_PYTHON = 'A Python script';

export async function openStarterSyncModal(page) {
  await openMoreActionsMenu(page);
  await page.locator('[role="menuitem"]:has-text("Sync Starter Code")').click();
}
