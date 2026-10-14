#!/usr/bin/env node
// PXL Classroom - LIVE probe: can a student read an Actions variable on their
// own repository, at the permission they have before the lock (admin) and
// after it (read)? Measured for delivering a student's extended deadline to
// their own page without publishing it to the cohort (live UI suite,
// 2026-10-15). Writes one variable per repository and deletes it again.
//
//   node tests/live/variable-probe.mjs <repo-admin> <repo-read>
//
// Both repositories are STUDENT_B's (TEST_LECTURER2) on the drill org.
//
//   node tests/live/variable-probe.mjs --as push|maintain <repo>
//
// sets STUDENT_B's permission on <repo> to that one for the read, and puts it
// back to what it was.

import { accounts, api, die, loadEnv } from "./live-kit.mjs";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const { LECTURER, STUDENT_B } = accounts(loadEnv());
const args = process.argv.slice(2);
const asIndex = args.indexOf("--as");
const as = asIndex >= 0 ? args.splice(asIndex, 2)[1] : null;
const repos = args;
if (repos.length === 0) die("usage: node tests/live/variable-probe.mjs [--as push|maintain] <repo>...");

const NAME = "PXL_PROBE_DEADLINE";
const setPermission = (repo, permission) => api(`/repos/${ORG}/${repo}/collaborators/${STUDENT_B.login}`, {
  token: LECTURER.token, method: "PUT", body: { permission },
});
for (const repo of repos) {
  const before = (await api(`/repos/${ORG}/${repo}/collaborators/${STUDENT_B.login}/permission`, { token: LECTURER.token })).data?.role_name;
  if (as) {
    const set = await setPermission(repo, as);
    console.log(`  ${repo}: ${STUDENT_B.login} ${before} -> ${as}: HTTP ${set.status}`);
  }
  const perm = await api(`/repos/${ORG}/${repo}/collaborators/${STUDENT_B.login}/permission`, { token: LECTURER.token });
  const made = await api(`/repos/${ORG}/${repo}/actions/variables`, {
    token: LECTURER.token, method: "POST", body: { name: NAME, value: "2026-10-20T22:00:00Z" },
  });
  const read = await api(`/repos/${ORG}/${repo}/actions/variables/${NAME}`, { token: STUDENT_B.token });
  const list = await api(`/repos/${ORG}/${repo}/actions/variables`, { token: STUDENT_B.token });
  const self = await api(`/repos/${ORG}/${repo}`, { token: STUDENT_B.token });
  console.log(JSON.stringify({
    repo,
    permission: perm.data?.role_name ?? `HTTP ${perm.status}`,
    created: made.status,
    student_reads_one: read.status, value: read.data?.value ?? null,
    student_lists: list.status,
    student_sees_repo: self.status, push: self.data?.permissions?.push ?? null,
  }));
  const gone = await api(`/repos/${ORG}/${repo}/actions/variables/${NAME}`, { token: LECTURER.token, method: "DELETE" });
  if (!gone.ok && gone.status !== 404) console.log(`  could not delete ${NAME} on ${repo}: HTTP ${gone.status}`);
  if (as && before) {
    const back = await setPermission(repo, before === "write" ? "push" : before);
    console.log(`  ${repo}: ${STUDENT_B.login} back to ${before}: HTTP ${back.status}`);
  }
}
