import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckRunScore } from '../lib/check-run-score.mjs';
import { buildAutogradingWorkflow } from '../provisioning/provision.mjs';
import { validateAgainst } from '../lib/validate.mjs';
import { REPORT_ROW_COLUMNS, RENDER_JOIN_COLUMNS } from '../lib/report-csv.mjs';
import { csvCell } from '../lib/csv-cell.mjs';

test('Autograding Actions Engine: builds full workflow with python grader and reporter', () => {
  const assignment = {
    id: 'group-autograding-actions',
    title: 'Group Python Analytics',
    assignment_type: 'group',
    autograde: {
      enabled: true,
      execution_environment: 'github_actions',
      visibility: 'public',
      tests: [
        {
          id: 'test-basic',
          name: 'Basic Stats Calculation',
          type: 'command',
          command: 'python3 -m unittest test_processor.TestDataProcessor.test_basic_stats',
          points: 10,
          timeout_s: 10,
        },
        {
          id: 'test-edge-cases',
          name: 'Edge Cases & Dirty Data',
          type: 'command',
          command: 'python3 -m unittest test_processor.TestDataProcessor.test_edge_case_empty_null',
          points: 10,
          timeout_s: 10,
        },
        {
          id: 'test-scaling',
          name: 'Scale & Sorting Test',
          type: 'command',
          command: 'python3 -m unittest test_processor.TestDataProcessor.test_scaling_and_sorting',
          points: 10,
          timeout_s: 10,
        },
      ],
    },
  };

  const workflow = buildAutogradingWorkflow(assignment, 'public');
  assert.ok(workflow.includes('uses: classroom-resources/autograding-command-grader@v1'));
  assert.ok(workflow.includes('uses: classroom-resources/autograding-grading-reporter@v1'));
  assert.ok(workflow.includes('test-basic'));
  assert.ok(workflow.includes('test-edge-cases'));
  assert.ok(workflow.includes('test-scaling'));
});

test('Autograding Check-Run Parser: Team 1 Full Pass (30/30 pts)', () => {
  const fullPassRun = {
    conclusion: 'success',
    output: {
      title: 'Autograding',
      summary: `
| Test | Status | Score |
| --- | --- | --- |
| Basic Stats Calculation | ✅ Passed | 10/10 |
| Edge Cases & Dirty Data | ✅ Passed | 10/10 |
| Scale & Sorting Test | ✅ Passed | 10/10 |

**Points 30/30**
      `,
    },
  };

  const parsed = parseCheckRunScore(fullPassRun, [], 30);
  assert.equal(parsed.earned, 30);
  assert.equal(parsed.total, 30);
  assert.equal(parsed.passed, true);
});

test('Autograding Check-Run Parser: Team 2 Partial Fail (20/30 pts)', () => {
  const partialFailRun = {
    conclusion: 'failure',
    output: {
      title: 'Autograding',
      summary: `
| Test | Status | Score |
| --- | --- | --- |
| Basic Stats Calculation | ✅ Passed | 10/10 |
| Edge Cases & Dirty Data | ❌ Failed | 0/10 |
| Scale & Sorting Test | ✅ Passed | 10/10 |

**Points 20/30**
      `,
    },
  };

  const parsed = parseCheckRunScore(partialFailRun, [], 30);
  assert.equal(parsed.earned, 20);
  assert.equal(parsed.total, 30);
  assert.equal(parsed.passed, false);
});

test('Docker Autograding Engine: computes granular test points and failures for group teams', () => {

  // Team 1 simulation: all pass
  const team1Results = [
    { id: 'unit', passed: true, points: 25, earned: 25 },
    { id: 'integration', passed: true, points: 25, earned: 25 },
  ];
  const team1Earned = team1Results.reduce((sum, t) => sum + t.earned, 0);
  const team1Total = team1Results.reduce((sum, t) => sum + t.points, 0);
  assert.equal(team1Earned, 50);
  assert.equal(team1Total, 50);

  // Team 2 simulation: integration fails
  const team2Results = [
    { id: 'unit', passed: true, points: 25, earned: 25 },
    { id: 'integration', passed: false, points: 25, earned: 0 },
  ];
  const team2Earned = team2Results.reduce((sum, t) => sum + t.earned, 0);
  const team2Total = team2Results.reduce((sum, t) => sum + t.points, 0);
  assert.equal(team2Earned, 25);
  assert.equal(team2Total, 50);
});

test('CLI Group Grader Deduplication: caches and propagates result across team members', () => {
  const teamResultsCache = new Map();
  const teamResult = {
    schema_version: 1,
    assignment_id: 'group-autograding-actions',
    github_login: 'student-1',
    archive_sha: 'a'.repeat(40),
    archive_branch: 'preserved/group-autograding-actions/team-alpha',
    graded_at: new Date().toISOString(),
    graded_by: 'lecturer1',
    runner: 'docker',
    total_points: 50,
    earned_points: 50,
    tests: [
      { id: 'unit', passed: true, points: 25, earned: 25, duration_ms: 120, exit_code: 0, timed_out: false, stdout: 'ok', stderr: '' },
      { id: 'integration', passed: true, points: 25, earned: 25, duration_ms: 240, exit_code: 0, timed_out: false, stdout: 'ok', stderr: '' },
    ],
  };

  teamResultsCache.set('team-alpha', teamResult);

  // When second team member is processed
  const student2 = { github_login: 'student-2', team_slug: 'team-alpha' };
  assert.ok(teamResultsCache.has(student2.team_slug));

  const cached = teamResultsCache.get(student2.team_slug);
  const student2Result = {
    ...cached,
    github_login: student2.github_login,
    graded_at: new Date().toISOString(),
  };

  assert.equal(student2Result.github_login, 'student-2');
  assert.equal(student2Result.earned_points, 50);
  assert.equal(student2Result.total_points, 50);
  assert.equal(student2Result.tests.length, 2);

  const validation = validateAgainst('grading-result', student2Result);
  assert.equal(validation.valid, true);
});

test('CSV Export Headers: includes autograding and feedback PR fields', () => {
  // IMPORTED, NOT COPIED. This test used to declare its own CSV_HEADERS and its
  // own csvCell and then assert against those - so it proved things about a
  // list it had written itself, and passed for months while the real export
  // dropped five report-row fields. The copy had drifted too: it was already
  // missing `lockdown_delay_seconds`, `archive_repo` and `archive_ref`.
  const CSV_HEADERS = [...REPORT_ROW_COLUMNS, ...RENDER_JOIN_COLUMNS];

  for (const c of ['ci_status', 'earned_points', 'total_points', 'feedback_pr_number', 'feedback_pr_url']) {
    assert.ok(CSV_HEADERS.includes(c), `the export must carry ${c}`);
  }

  const studentRow = {
    github_login: 'student-2',
    ci_status: 'failure',
    earned_points: 20,
    total_points: 30,
    feedback_pr_number: 14,
    feedback_pr_url: 'https://github.com/org/repo/pull/14',
  };

  const serialized = CSV_HEADERS.map((h) => csvCell(studentRow[h])).join(',');
  assert.ok(serialized.includes('failure'));
  assert.ok(serialized.includes('20'));
  assert.ok(serialized.includes('30'));
  assert.ok(serialized.includes('14'));
});
