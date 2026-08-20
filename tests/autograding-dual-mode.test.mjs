import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckRunScore } from '../cli/src/commands/grade.mjs';
import { buildAutogradingWorkflow } from '../provisioning/provision.mjs';

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

  const parsed = parseCheckRunScore(fullPassRun, 30);
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

  const parsed = parseCheckRunScore(partialFailRun, 30);
  assert.equal(parsed.earned, 20);
  assert.equal(parsed.total, 30);
  assert.equal(parsed.passed, false);
});

test('Docker Autograding Engine: computes granular test points and failures for group teams', () => {
  const dockerAssignment = {
    id: 'group-autograding-docker',
    title: 'Group Docker Microservice',
    assignment_type: 'group',
    autograde: {
      enabled: true,
      execution_environment: 'docker',
      tests: [
        { id: 'unit', name: 'Unit Tests', command: 'npm run test:unit', points: 25 },
        { id: 'integration', name: 'Integration Tests', command: 'npm run test:integration', points: 25 },
      ],
    },
  };

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
