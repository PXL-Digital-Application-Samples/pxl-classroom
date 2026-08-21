import { existsSync } from 'node:fs';
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
    user: { login: user.login, name: user.name },
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
  assignments = {},
  teams = {},
  reports = {},
  currentUser = STUDENT_2,
  userRepos = [],
  invitations = [],
  brokerIssues = [],
} = {}) {
  // Assignments JSON
  await page.route(`**/data/${org}/assignments.json*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schema_version: 1,
        generated_at: new Date().toISOString(),
        assignments,
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
      await route.fulfill({ status: 200, body: JSON.stringify(invitations) });
    } else if (url.includes('/user')) {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ login: currentUser.login, id: 999999, name: currentUser.name }),
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
      if (url.includes('/pxl-classroom-control/contents/reports/')) {
        const match = url.match(/\/reports\/([^/?#]+)\.json/);
        const asgnId = match ? match[1] : null;
        const rep = asgnId && reports[asgnId] ? reports[asgnId] : null;
        if (rep) {
          const contentBase64 = Buffer.from(JSON.stringify(rep)).toString('base64');
          await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
          return;
        }
      } else if (url.includes('/pxl-classroom-control/contents/assignments/')) {
        const match = url.match(/\/assignments\/([^/?#]+)\.ya?ml/);
        const asgnId = match ? match[1] : null;
        if (asgnId && assignments[asgnId]) {
          const yamlContent = yamlStringify(assignments[asgnId]);
          const contentBase64 = Buffer.from(yamlContent).toString('base64');
          await route.fulfill({ status: 200, body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
          return;
        }
        await route.fulfill({ status: 200, body: JSON.stringify([]) });
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
        // Commits list
        await route.fulfill({
          status: 200,
          body: JSON.stringify([
            {
              sha: 'c0ffee1234567890abcdef1234567890abcdef12',
              commit: {
                message: 'docs: update lab instructions in README.md and add validation tests',
                author: { name: 'Lecturer Alice', date: new Date().toISOString() },
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
      } else {
        await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
      }
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify({}) });
    }
  });
}
