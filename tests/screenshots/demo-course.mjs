// A fictional course for the README's screenshots (tests/screenshots/).
//
// Every name, login, number and address here is invented. The logins carry a
// `demo-` prefix so none of them is mistaken for a real GitHub account, and
// the addresses are at example.edu for the same reason. Times are relative to
// when the script runs, so "2 hours ago" and "in 5 days" read naturally.

export const ORG = 'PXL-Demo-Course-2627';
const NOW = Date.now();
const H = 3600_000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const sha = (n) => (n.toString(16) + 'a3f9c27e1d4b8065').repeat(5).slice(0, 40);

// A login containing "lecturer" is staff in the shared e2e fixture.
export const LECTURER = { login: 'demo-lecturer', id: 910001, name: 'Demo Lecturer', token: 'mock_demo_lecturer' };

const PEOPLE = [
  ['Alice', 'Vermeulen', '3A'], ['Bram', 'Peeters', '3A'], ['Cara', 'Janssens', '3A'], ['Dries', 'Maes', '3A'],
  ['Eva', 'Willems', '3A'], ['Femke', 'Claes', '3A'], ['Gilles', 'Goossens', '3A'], ['Hanne', 'Wouters', '3A'],
  ['Ibe', 'De Smet', '3B'], ['Jana', 'Mertens', '3B'], ['Kobe', 'Jacobs', '3B'], ['Lotte', 'Dubois', '3B'],
  ['Milan', 'Lambrechts', '3B'], ['Nora', 'Hermans', '3B'], ['Oscar', 'Michiels', '3B'], ['Pauline', 'Aerts', '3B'],
];

export const STUDENTS = PEOPLE.map(([first, last, group], i) => ({
  login: `demo-${first.toLowerCase()}`,
  full_name: `${first} ${last}`,
  student_number: String(12345601 + i),
  class_group: group,
  email: `${first}.${last.replace(/\s+/g, '')}@example.edu`.toLowerCase(),
  id: 920001 + i,
}));

export const STUDENT = { login: STUDENTS[0].login, id: STUDENTS[0].id, name: STUDENTS[0].full_name, token: 'mock_demo_student' };

export const ROSTER = STUDENTS.map((s) => ({
  student_number: s.student_number,
  full_name: s.full_name,
  class_group: s.class_group,
  email: s.email,
  github_login: s.login,
}));

// --- assignments ----------------------------------------------------------

const LAB = 'lab-3-docker-networking';
const PROJECT = 'project-cicd-pipeline';
const EXAM = 'exam-linux-administration';
const DRAFT = 'lab-4-kubernetes';

const tests = (n) => Array.from({ length: n }, (_, i) => ({ id: `check-${i + 1}`, name: `Check ${i + 1}`, run: 'true', points: 2 }));

export const ASSIGNMENTS = {
  [LAB]: {
    schema_version: 1, id: LAB, title: 'Lab 3: Docker networking', organization: ORG, state: 'published',
    assignment_type: 'individual', roster_mode: 'enforced',
    template: { owner: ORG, repository: 'lab-3-docker-networking-template' },
    repository_name_pattern: `${LAB}-{github_login}`, broker_repo: `broker-${LAB}`,
    opens_at: iso(NOW - 6 * D), deadline_at: iso(NOW + 4 * D + 5 * H),
    late_policy: 'report', lock_down_enabled: true,
    autograde: { enabled: true, execution_environment: 'github_actions', runner: 'github_actions', tests: tests(5) },
  },
  [PROJECT]: {
    schema_version: 1, id: PROJECT, title: 'Group project: CI/CD pipeline', organization: ORG, state: 'published',
    assignment_type: 'group', roster_mode: 'enforced',
    template: { owner: ORG, repository: 'cicd-pipeline-template' },
    repository_name_pattern: `${PROJECT}-{team_slug}`, broker_repo: `broker-${PROJECT}`,
    opens_at: iso(NOW - 3 * D), deadline_at: iso(NOW + 18 * D),
    group_config: { max_team_size: 4, min_team_size: 2, formation_mode: 'self-service' },
  },
  [EXAM]: {
    schema_version: 1, id: EXAM, title: 'Exam: Linux administration', organization: ORG, state: 'closed',
    assignment_type: 'individual', roster_mode: 'enforced',
    template: { owner: ORG, repository: 'linux-exam-template' },
    repository_name_pattern: `${EXAM}-{github_login}`, broker_repo: `broker-${EXAM}`,
    opens_at: iso(NOW - 9 * D - 3 * H), deadline_at: iso(NOW - 9 * D),
    late_policy: 'block', lock_down_enabled: true, template_grades: true,
    autograde: { enabled: true, execution_environment: 'github_actions', runner: 'github_actions', tests: tests(10) },
  },
  [DRAFT]: {
    schema_version: 1, id: DRAFT, title: 'Lab 4: Kubernetes basics', organization: ORG, state: 'draft',
    assignment_type: 'individual', roster_mode: 'enforced',
    template: { owner: ORG, repository: 'lab-4-kubernetes-template' },
    repository_name_pattern: `${DRAFT}-{github_login}`,
    deadline_at: iso(NOW + 25 * D),
  },
};

// --- reports --------------------------------------------------------------

function row(s, assignmentId, i, { status, committedAgo, commits, deadline, preserved = false, team = null, claimed = false }) {
  const repo = team ? `${assignmentId}-${team}` : `${assignmentId}-${s.login}`;
  const base = {
    github_login: s.login,
    full_name: s.full_name,
    student_number: s.student_number,
    class_group: s.class_group,
    ...(claimed ? { claimed_email: s.email, claim_verified: true } : {}),
    acceptance_state: 'provisioned',
    submission_status: status,
    repo_name: `${ORG}/${repo}`,
    repo_url: `https://github.com/${ORG}/${repo}`,
    effective_deadline_at: deadline,
    latest_observed_at: iso(NOW - 2 * H - i * 60_000),
    latest_observation_type: 'scheduled',
    commit_count: commits,
    ...(team ? { team_slug: team } : {}),
  };
  if (status === 'no-submission') return { ...base, commit_count: 1 };
  const at = iso(NOW - committedAgo);
  return {
    ...base,
    latest_observed_sha: sha(i + 1),
    commit_date: at,
    latest_commit_date: at,
    commit_message: ['Add the bridge network', 'Expose the API on port 8080', 'Fix the healthcheck', 'Write the compose file'][i % 4],
    ...(status === 'on-time' ? { last_on_time_sha: sha(i + 1) } : {}),
    ...(preserved ? { preservation_status: 'preserved', preserved_sha: sha(i + 1) } : {}),
  };
}

const labDeadline = ASSIGNMENTS[LAB].deadline_at;
const examDeadline = ASSIGNMENTS[EXAM].deadline_at;

const labRows = STUDENTS.map((s, i) => row(s, LAB, i, {
  status: i === 6 || i === 13 ? 'no-submission' : 'on-time',
  committedAgo: (i % 5) * 7 * H + (i + 1) * 23 * 60_000,
  commits: 3 + (i % 6),
  deadline: labDeadline,
}));

const examRows = STUDENTS.map((s, i) => row(s, EXAM, i, {
  status: i === 13 ? 'no-submission' : i === 9 ? 'late' : 'on-time',
  committedAgo: 9 * D + (i === 9 ? -4 * 60_000 : (i + 2) * 3 * 60_000),
  commits: 6 + (i % 5),
  deadline: examDeadline,
  preserved: i !== 13,
  claimed: true,
}));

export const TEAMS = [
  ['cloud-nine', 'Cloud Nine', [0, 1, 2, 3]],
  ['pipeline-pros', 'Pipeline Pros', [4, 5, 6, 7]],
  ['green-builds', 'Green Builds', [8, 9, 10, 11]],
  ['the-deployers', 'The Deployers', [12, 13, 14, 15]],
];

// One repository per team: every member's row carries the team's commits.
const teamCommits = { 'cloud-nine': 23, 'pipeline-pros': 17, 'green-builds': 31, 'the-deployers': 1 };
const projectRows = TEAMS.flatMap(([slug, , members], t) => members.map((i) => row(STUDENTS[i], PROJECT, t, {
  status: slug === 'the-deployers' ? 'no-submission' : 'on-time',
  committedAgo: (t + 1) * 5 * H,
  commits: teamCommits[slug],
  deadline: ASSIGNMENTS[PROJECT].deadline_at,
  team: slug,
})));

const report = (id, students, extra = {}) => ({ schema_version: 1, assignment_id: id, generated_at: iso(NOW - 40 * 60_000), students, ...extra });

export const REPORTS = {
  [LAB]: report(LAB, labRows),
  [EXAM]: report(EXAM, examRows),
  [PROJECT]: report(PROJECT, projectRows, {
    teams: TEAMS.map(([slug, name, members], t) => ({
      team_slug: slug, team_name: name, members: members.map((i) => STUDENTS[i].login),
      repo_name: `${ORG}/${PROJECT}-${slug}`, repo_url: `https://github.com/${ORG}/${PROJECT}-${slug}`,
      submission_status: slug === 'the-deployers' ? 'no-submission' : 'on-time',
      commit_count: teamCommits[slug],
      ...(slug === 'the-deployers' ? {} : { latest_observed_sha: sha(t + 1) }),
    })),
  }),
};

// The overview's cards read the roll-up (`reports/dashboard.json`), counted
// here from the same rows the tabs show, so the two always agree.
function rollUp(id) {
  const a = ASSIGNMENTS[id];
  const rows = REPORTS[id].students;
  const count = (status) => rows.filter((r) => r.submission_status === status).length;
  return {
    title: a.title, state: a.state, opens_at: a.opens_at, deadline_at: a.deadline_at, timezone: 'Europe/Brussels',
    max_acceptances: null, total_students: rows.length, accepted: rows.length, provisioned: rows.length,
    on_time: count('on-time'), late: count('late'), no_submission: count('no-submission'), with_repo_faults: 0,
    generated_at: REPORTS[id].generated_at,
  };
}
REPORTS.dashboard = { assignments: Object.fromEntries([LAB, PROJECT, EXAM].map((id) => [id, rollUp(id)])) };

export const CONTROL_TEAMS = {
  [PROJECT]: TEAMS.map(([slug, name, members]) => ({
    schema_version: 1, assignment_id: PROJECT, team_slug: slug, team_name: name,
    members: members.map((i) => STUDENTS[i].login), max_members: 4,
    created_at: iso(NOW - 2 * D), created_by: STUDENTS[members[0]].login,
    repo_name: `${ORG}/${PROJECT}-${slug}`,
  })),
};

// --- grading --------------------------------------------------------------

const scores = [10, 9, 10, 8, 7, 10, 9, 6, 10, 8, 9, 10, 7, null, 9, 8];
const examPoints = (i) => scores[i] * 2;

export const GRADING = {
  [EXAM]: {
    schema_version: 1, assignment_id: EXAM, generated_at: iso(NOW - 70 * 60_000), graded_by: LECTURER.login, runner: 'github_actions',
    students: STUDENTS.flatMap((s, i) => (scores[i] === null || i === 9 ? [] : [{
      login: s.login, earned_points: examPoints(i), total_points: 20, ci_status: 'success',
      ci_run_url: `https://github.com/${ORG}/${EXAM}-${s.login}/actions/runs/${700000 + i}`,
      score_source: 'annotation-json', graded_at: iso(NOW - 70 * 60_000), graded_sha: sha(i + 1),
    }])),
    failed: [
      { login: STUDENTS[13].login, reason: 'nothing was handed in: the repository is still as it was given', kind: 'not-handed-in' },
      { login: STUDENTS[9].login, reason: 'the only hand-in was pushed after the deadline', kind: 'late' },
    ],
  },
  [LAB]: {
    schema_version: 1, assignment_id: LAB, generated_at: iso(NOW - 3 * H), graded_by: LECTURER.login, runner: 'github_actions',
    students: STUDENTS.flatMap((s, i) => (i === 6 || i === 13 ? [] : [{
      login: s.login, earned_points: [10, 8, 10, 6, 10, 8, 0, 10, 8, 10, 6, 10, 8, 0, 10, 4][i], total_points: 10, ci_status: 'success',
      ci_run_url: `https://github.com/${ORG}/${LAB}-${s.login}/actions/runs/${800000 + i}`,
      score_source: 'annotation-json', graded_at: iso(NOW - 3 * H), graded_sha: sha(i + 1),
    }])),
    failed: [],
  },
};

export const USAGE = {
  schema_version: 1,
  week_start: new Date(NOW - 7 * D).toISOString().slice(0, 10),
  week_end: new Date(NOW - D).toISOString().slice(0, 10),
  generated_at: iso(NOW - 12 * H),
  over_count: 0,
  items: [
    { repo: `${LAB}-demo-alice`, sku: 'actions_minutes', used: 38, limit: 2000, over: false },
    { repo: `${EXAM}-demo-bram`, sku: 'actions_minutes', used: 64, limit: 2000, over: false },
  ],
};

export const IDS = { LAB, PROJECT, EXAM, DRAFT };
