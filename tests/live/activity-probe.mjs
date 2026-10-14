#!/usr/bin/env node
// PXL Classroom - LIVE, READ-ONLY: can a student's own token read their
// repository's push log? Not part of `npm test`.
//
//   node tests/live/activity-probe.mjs <repo> [<repo> ...]
//
// The student pages decide "nothing handed in" from `GET /repos/{o}/{r}/activity`
// (lib/untouched-repo.mjs `personPushed`, review 2026-10-14, PG7): a log naming
// only PXL Classroom's App is a repository nobody pushed to. If the student's
// token cannot read it, both pages fall back to the newest commit's date, and
// nobody had measured which (P2-15). Each repository is read as the student who
// holds it and as the lecturer, and what each answer is is printed. Nothing is
// written.

import { api, die, loadEnv, reporter, accounts } from "./live-kit.mjs";
import { APP_SLUG } from "../../lib/deployment.mjs";
import { personPushed } from "../../lib/untouched-repo.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const { LECTURER, STUDENT_A, STUDENT_B } = accounts(env);
if (!LECTURER.token || !STUDENT_A.token) die("TEST_LECTURER_TOKEN and TEST_STUDENT1_TOKEN are required (.env.test)");
const repos = process.argv.slice(2);
if (!repos.length) die("usage: node tests/live/activity-probe.mjs <repo> [<repo> ...]  (repositories in the probe org, held by a test student)");
const r = reporter();

for (const repo of repos) {
  console.log(`\n${org}/${repo}\n`);
  const holder = [STUDENT_A, STUDENT_B].find((s) => s?.login && repo.toLowerCase().endsWith(s.login.toLowerCase()));
  for (const who of [holder, LECTURER].filter(Boolean)) {
    const log = await api(`/repos/${org}/${repo}/activity?per_page=100`, { token: who.token });
    const head = await api(`/repos/${org}/${repo}/commits?per_page=1`, { token: who.token });
    const perm = await api(`/repos/${org}/${repo}/collaborators/${encodeURIComponent(who.login)}/permission`, { token: LECTURER.token });
    const actors = log.ok && Array.isArray(log.data) ? [...new Set(log.data.map((a) => a?.actor?.login))] : null;
    const verdict = personPushed(log, head.ok && Array.isArray(head.data) ? head.data[0] : null);
    const line = `${who.login} (permission ${perm.data?.permission ?? "?"}): activity HTTP ${log.status}` +
      (actors ? `, ${log.data.length} entr${log.data.length === 1 ? "y" : "ies"} by ${actors.join(", ") || "nobody"}` : "") +
      `; personPushed = ${verdict}`;
    if (log.ok) r.ok(line);
    else r.bad(line);
  }
}
console.log(`\n(${APP_SLUG}[bot] is PXL Classroom's App.)`);
console.log(`\n${r.failures() === 0 ? "Every read answered." : `${r.failures()} read(s) refused.`}\n`);
