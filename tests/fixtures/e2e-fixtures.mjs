import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';

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
    } else if (url.includes('/user/installations')) {
      const isLecturerUser = currentUser.login.toLowerCase().includes('lecturer');
      const instList = isLecturerUser ? participatingOrgs.map((o) => ({
        id: 1000 + (typeof o === 'string' ? 1 : 2),
        account: { type: 'Organization', login: typeof o === 'string' ? o : o.login },
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
        await route.fulfill({ status: 204, body: '' });
        return;
      } else if (url.includes('/compare/')) {
        // Compare API for pre-flight scan
        const match = url.match(/\/compare\/(.+)\.\.\.(.+)/);
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
