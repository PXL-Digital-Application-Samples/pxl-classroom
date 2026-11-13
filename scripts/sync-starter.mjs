#!/usr/bin/env node
// PXL Classroom - smart starter code synchronization.
//
// Copies the changes from ONE template commit into student repositories:
// straight onto `main` for every file the student has not touched, and onto a
// `starter-update-<ts>` branch with a pull request for the ones they have.
//
// It copies content and never merges history - see lib/starter-sync.mjs for
// what the merge-based implementation this replaced actually did to a
// repository created from a template, and which half of it was a 404.

import { appendFile, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gh, ghAll } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";
import { commitWithRebase, requestDetail } from "../lib/gittree.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { CONTROL_REPO } from "../lib/deployment.mjs";
import {
  branchRefusedByRule,
  branchRefusedMessage,
  changedPaths,
  closeSupersededSyncPrs,
  filesForPullRequest,
  isRuleRefusal,
  outcomeFor,
  ruleRefusalReason,
  syncBranchName,
  syncMarker,
  findExistingSyncPr,
  readTemplateCommit,
  selectionIsAll,
  startingPointFor,
  syncRefusal,
} from "../lib/starter-sync.mjs";
import { blobOf, listTemplateCommits, modeOf, planStudent, repoOrigin, rootCommit, treeReader } from "../lib/starter-sync-cohort.mjs";
import { assignmentOutcome, issueAssignees, loginsByRepo, oneRecordPerRepo } from "../lib/sync-issue.mjs";
import { sameLogin } from "../lib/github-login.mjs";
import { submissionBranch } from "../lib/submission-marker.mjs";
import { buildSyncRecord, failedRow, generateSyncId, progressFlusher, syncRow } from "../lib/sync-record.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR", "."),
  selectedFiles: env("SELECTED_FILES", '["*"]'),
  prTitle: env("PR_TITLE", ""),
  prBody: env("PR_BODY", ""),
  createIssue: env("CREATE_ISSUE", "true") === "true",
  actor: env("ACTOR", "lecturer"),
  // Blank syncs the template's newest commit.
  templateCommit: env("TEMPLATE_COMMIT", ""),
  // How long ONE ROUND may spend on students before it stops itself and says
  // where. Under the App token's hour, which is what a round runs on, with
  // room for the student it is in the middle of and the final record: past
  // the hour every write is a 401, and a step the timeout kills writes
  // nothing afterwards.
  budgetMs: Number(env("SYNC_BUDGET_MS", "")) || 52 * 60_000,
  // A sync that reaches its budget CONTINUES BY ITSELF where the workflow
  // gives it another round (sync-starter-code.yml: a fresh token, then this
  // script again, which skips everyone who has the change). `round` of
  // `rounds`; alone, as the CLI and the tests run it, it is 1 of 1 and stops
  // as it always did.
  round: Math.max(1, Number(env("SYNC_ROUND", "")) || 1),
  rounds: Math.max(1, Number(env("SYNC_ROUNDS", "")) || 1),
};

// The one output the workflow reads (`continues`): does another round follow?
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The transport lib/starter-sync-cohort.mjs reads through: gh() already
// answers `{ ok, status, headers, data }` and never throws.
const get = (path) => gh("GET", path, null, { token: cfg.token });
// A student's own tree, read once, refusing a truncated listing like the
// template's.
const readStudentTree = treeReader(get);

// Trees are read through lib/starter-sync-cohort.mjs `treeReader`, which
// refuses a truncated listing: every unlisted path would look absent, which
// reads as "the student deleted it" and would restore files nobody touched.

/**
 * Every sync record already written for this assignment, from the checkout. A
 * record that does not parse is skipped - it can only make a student start
 * EARLIER (from their generated commit), which sends more, never less.
 */
async function readSyncRecords(dir) {
  let names = [];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      console.log(`[warn] sync record ${name} is unreadable and is not used as a starting point`);
    }
  }
  return out;
}

async function main() {
  if (!cfg.token) throw new Error("GITHUB_TOKEN is required");
  if (!cfg.org) throw new Error("ORG is required");
  if (!cfg.assignmentId) throw new Error("ASSIGNMENT_ID is required");

  let requestedFiles = ["*"];
  try {
    const parsed = JSON.parse(cfg.selectedFiles);
    if (Array.isArray(parsed) && parsed.length > 0) requestedFiles = parsed;
  } catch {
    requestedFiles = ["*"];
  }

  // 1. Read assignment YAML.
  //
  // `loadYaml` takes a PATH and is async. This passed it the file's text and
  // did not await it, so `assignment` was a Promise, `assignment.template` was
  // undefined, and the script died on the line below with "Assignment has no
  // template repository configured" - for every assignment, always. Found by
  // running it: nothing had, because the workflow could not mint a token in
  // the first place.
  const asgnPath = join(cfg.dataDir, "assignments", `${cfg.assignmentId}.yml`);
  const assignment = await loadYaml(asgnPath);

  const tplOwner = assignment.template?.owner || cfg.org;
  const tplRepo = assignment.template?.repository;
  if (!tplRepo) throw new Error("Assignment has no template repository configured");
  // Before anything is read or written: nothing was sent, so there is nothing
  // to record.
  const refused = syncRefusal(assignment);
  if (refused) throw new Error(`Not synced: ${refused}.`);

  const templateFullName = `${tplOwner}/${tplRepo}`;
  console.log(`[sync] Template repository: ${templateFullName}`);
  // THE SUBMISSION BRANCH, which is the template's default and the only branch
  // a student repository gets. `main` was written into every read and write,
  // so on a `master` template every student read 404 and was reported failed
  // (third review, 2026-09-26).
  const branch = submissionBranch(assignment);

  // 2. The commit being synced, and the one before it. The newest, unless the
  //    lecturer named one (lib/starter-sync.mjs `readTemplateCommit` says why).
  const chosen = readTemplateCommit(cfg.templateCommit);
  if (chosen && typeof chosen === "object") throw new Error(chosen.error);

  let requestedSha = chosen;
  if (!requestedSha) {
    const tplCommits = await gh("GET", `/repos/${templateFullName}/commits?per_page=1`, null, { token: cfg.token });
    if (!tplCommits.ok || !tplCommits.data?.[0]) {
      throw new Error(`Could not fetch commits from template ${templateFullName} (HTTP ${tplCommits.status})`);
    }
    requestedSha = tplCommits.data[0].sha;
  }

  const detail = await gh("GET", `/repos/${templateFullName}/commits/${requestedSha}`, null, { token: cfg.token });
  if (!detail.ok) {
    throw new Error(
      chosen
        ? `Template ${templateFullName} has no commit ${chosen} (HTTP ${detail.status}) - check the sha on the template's commit list`
        : `Could not read template commit ${requestedSha.slice(0, 7)} (HTTP ${detail.status})`,
    );
  }
  // The FULL sha from here on, whatever length was typed: the pull request
  // marker and the record key on it.
  const templateSha = detail.data.sha;
  if (chosen) console.log(`[sync] Syncing the named commit ${templateSha.slice(0, 7)}, not the newest.`);

  const commitMsgTitle = (detail.data.commit?.message || "").split("\n")[0] || "Update starter code";
  const parentSha = detail.data.parents?.[0]?.sha || null;
  console.log(`[sync] Target template commit: ${templateSha.slice(0, 7)} - "${commitMsgTitle}"`);

  // EACH STUDENT IS SENT WHAT THEY ARE MISSING, from the template commit they
  // are known to be at up to this one - not what this one commit changed
  // (lib/starter-sync.mjs `startingPointFor`). The commit's own file list is
  // only what the log reports as "this commit"; the plan is built from trees.
  const newest = changedPaths(detail.data.files);
  console.log(`[sync] This commit changed ${newest.length} file(s); each student is sent everything they are behind on.`);
  const allFiles = selectionIsAll(requestedFiles);
  if (!allFiles) console.log(`[sync] Selection: ${JSON.stringify(requestedFiles)}`);

  const readTemplateTree = treeReader(get);
  const headTree = await readTemplateTree(templateFullName, templateSha);

  // Where students start: sync records first (read from this checkout), then
  // the template commit whose tree their first commit carries. One listing of
  // the template's commits serves the whole cohort.
  const records = await readSyncRecords(join(cfg.dataDir, "syncs", cfg.assignmentId));
  const listed = await listTemplateCommits(get, templateFullName);
  if (!listed.ok) {
    console.log(`[warn] could not list the template's commits (HTTP ${listed.status}) - a student with no sync record starts from this commit's parent`);
  } else if (!listed.complete) {
    console.log("[warn] the template has more than 1,000 commits; an older starting point may not be found");
  }
  const templateCommits = listed.commits;

  // Content is fetched ONCE per path, when the first student needs it.
  const contentByPath = new Map();
  const contentOf = async (path) => {
    if (!contentByPath.has(path)) {
      const sha = blobOf(headTree.get(path));
      const blob = await gh("GET", `/repos/${templateFullName}/git/blobs/${sha}`, null, { token: cfg.token });
      if (!blob.ok) throw new Error(`could not read ${path} from the template (HTTP ${blob.status})`);
      // Kept as a Buffer so binary starter files (images, fixtures, archives)
      // survive; gittree base64-encodes a Buffer unchanged.
      contentByPath.set(path, Buffer.from(blob.data.content || "", blob.data.encoding || "base64"));
    }
    return contentByPath.get(path);
  };
  // Every path any student was planned a change for - the record's
  // `selected_files`, which says what was applied rather than what was offered.
  const appliedPaths = new Set();

  const syncTitle = cfg.prTitle || `Starter Code Update: ${commitMsgTitle}`;
  const syncBody = cfg.prBody || [
    "### Starter Code Update",
    "",
    // "An update", not "a correction": the same sync ships a new lab each
    // week on a semester-long assignment, where nothing was wrong.
    `An update from the starter template (\`${templateFullName}\`) is available.`,
    "",
    `- **Commit:** \`${templateSha.slice(0, 7)}\` - ${commitMsgTitle}`,
    "",
    "You changed these files, so they were not overwritten. Review the diff and merge when you are ready.",
  ].join("\n");

  // 3. Read student repository records
  const reposDir = join(cfg.dataDir, "repositories", cfg.assignmentId);
  let repoFiles = [];
  try {
    repoFiles = (await readdir(reposDir)).filter((f) => f.endsWith(".json"));
  } catch {
    console.log(`[sync] No repositories directory for ${cfg.assignmentId}`);
  }
  // Every repository record, read once, up front. One that cannot be read is
  // REPORTED as a failed row rather than thrown: one unreadable record used to
  // stop the run partway, after some students had been changed, with no
  // record of who (accept.mjs guards the same file type for the same reason).
  const recs = [];
  const unreadableRows = [];
  for (const file of repoFiles) {
    try {
      recs.push(JSON.parse(await readFile(join(reposDir, file), "utf8")));
    } catch (err) {
      // Named <login>.json, so the filename still identifies the student.
      const named = file.replace(/\.json$/, "");
      console.log(`[fail] ${named}: repository record is unreadable - ${err.message}`);
      unreadableRows.push({ github_login: named, repo_name: "unknown", outcome: "failed", error: `repository record unreadable: ${err.message}` });
    }
  }
  // Asked again with the records, still before anything is written: a student
  // given the full history makes the whole sync refuse, whatever the setting
  // says now (lib/starter-sync.mjs `syncRefusal`).
  const refusedByRecords = syncRefusal(assignment, recs);
  if (refusedByRecords) throw new Error(`Not synced: ${refusedByRecords}.`);
  // Who shares each repository, for assigning its tracking issue.
  const byRepo = loginsByRepo(recs);
  // ONE REPOSITORY, ONE PLAN - as the CLI already did. A team is a record per
  // member naming one repository, and planned per member the second plan read
  // the tree as it was before the first member's commit: the same files were
  // written again as an empty commit, and without a pull request a second
  // tracking issue emailed every member again (third review, 2026-09-26).
  // Planned through the member whose start is best known; every member still
  // gets a row, because the next sync reads each member's own.
  const repoKey = (rec) => String(rec?.repo_name || "").split("/").pop();
  const perRepo = oneRecordPerRepo(
    recs,
    repoKey,
    (rec) => (startingPointFor({ login: rec.github_login, records }).source === "synced" ? 1 : 0),
  );

  const syncId = generateSyncId();
  const results = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = Number(process.env.GITHUB_RUN_ID) || null;
  const runUrl = runId && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
    : null;

  // THE RECORD IS WRITTEN WHEN THE RUN STARTS, AS IT GOES, AND WHEN IT ENDS.
  // It used to be written once, at the end, by a later step - so a run the
  // timeout stopped left no record at all of the students it had already
  // changed, and nothing on screen could say a sync was running, had stopped,
  // or how far it got (.NET Advanced, 2026-09-25).
  // lib/sync-record.mjs, shared with the CLI. A partial record is evidence
  // too - for exactly the students in `results`.
  const buildRecord = (status, remaining) => buildSyncRecord({
    syncId, assignmentId: cfg.assignmentId, startedAt, syncedBy: cfg.actor, status, runId, runUrl,
    totalStudents: repoFiles.length, remaining, templateRepo: templateFullName, templateSha,
    templateBaseSha: parentSha, appliedPaths, allFiles, prTitle: syncTitle, prBody: syncBody,
    createdIssues: cfg.createIssue, results,
  });

  const recordPath = `syncs/${cfg.assignmentId}/${syncId}.json`;
  const writeRecord = async (doc, message) => {
    // Validated before every write: this is what a lecturer reads to see who
    // got the change, and a document the backend cannot read back is worse
    // than none.
    const { valid, errors } = validateAgainst("sync-record", doc);
    if (!valid) {
      throw new Error(
        "sync record does not match sync-record.schema.json: " +
          errors.slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; "),
      );
    }
    const body = JSON.stringify(doc, null, 2) + "\n";
    await commitWithRebase({
      token: cfg.token,
      apiBase: process.env.GITHUB_API_URL || undefined,
      owner: cfg.org,
      repo: CONTROL_REPO,
      branch: "main",
      message,
      changes: [{ path: recordPath, content: body }],
    });
    // And in this checkout, where later steps and the tests read it.
    await mkdir(join(cfg.dataDir, "syncs", cfg.assignmentId), { recursive: true });
    await writeFile(join(cfg.dataDir, recordPath), body);
  };

  // Nothing is sent unless the start can be recorded: a sync nobody can see
  // is the thing this record exists to end.
  await writeRecord(buildRecord("running"), `Start starter code sync for ${cfg.assignmentId}`);
  console.log(`[sync] Recorded the start as ${recordPath}${runUrl ? ` (${runUrl})` : ""}`);

  // Progress, so a run that dies mid-cohort still says who it reached. Best
  // effort: a failed progress write is logged and the sync goes on - the
  // students matter more than the tally, and the final write is not optional.
  // Counted in FINISHED students (`results`), checked before each next one.
  // The policy is lib/sync-record.mjs `progressFlusher`, shared with the CLI.
  const flush = progressFlusher({
    write: () => writeRecord(buildRecord("running"), `Starter code sync progress for ${cfg.assignmentId}`),
    onError: (err) => console.log(`[warn] could not record progress: ${err.message}`),
  });
  const maybeFlush = () => flush(results.length);

  results.push(...unreadableRows);
  // The other members of the repository `rec` was planned through - each gets
  // the same row under their own login.
  const teammates = (rec) => recs.filter((o) => o !== rec && repoKey(o) && repoKey(o).toLowerCase() === repoKey(rec).toLowerCase());
  let remaining = 0;
  for (const [index, rec] of perRepo.entries()) {
    // The sync stops ITSELF before the job's timeout does, so that it can say
    // where it stopped: a job the timeout kills writes nothing afterwards.
    // Counted in STUDENTS, the unit `total_students` is in.
    if (Date.now() - t0 > cfg.budgetMs) {
      remaining = perRepo.slice(index).reduce((n, r) => n + 1 + teammates(r).length, 0);
      console.log(
        cfg.round < cfg.rounds
          ? `[stop] time budget reached with ${remaining} student(s) not yet reached - continuing by itself in round ${cfg.round + 1} of ${cfg.rounds}`
          : `[stop] time budget reached with ${remaining} student(s) not yet reached - run the sync again to finish them`,
      );
      break;
    }
    await maybeFlush();
    const pushed = results.length;
    await syncOne(rec);
    // Every other member of a shared repository: the same outcome, their login.
    for (const mate of teammates(rec)) {
      for (const row of results.slice(pushed)) {
        if (sameLogin(row.github_login, rec.github_login)) results.push({ ...row, github_login: mate.github_login, ...(mate.team_slug ? { team_slug: mate.team_slug } : {}) });
      }
    }
    // Rate-limit throttle
    await sleep(300);
  }

  async function syncOne(rec) {
    const login = rec.github_login;
    const teamSlug = rec.team_slug;
    const repoNameFull = rec.repo_name;
    const repoName = repoNameFull?.split("/")[1] || repoNameFull;

    if (!repoName) {
      results.push({ github_login: login, team_slug: teamSlug, repo_name: "unknown", outcome: "skipped-no-repo" });
      return;
    }

    const studentFullName = `${cfg.org}/${repoName}`;
    // Named before the plan, so a failure while planning still has a row.
    let row = { github_login: login, repo_name: studentFullName, ...(teamSlug ? { team_slug: teamSlug } : {}) };
    // What the commit did besides the plain path (a request tried again,
    // files uploaded one by one): the reason a student took minutes.
    const onNote = (text) => console.log(`[note] ${login}: ${text}`);

    try {
      const studentTree = await readStudentTree(studentFullName, branch);
      const { from, source, plan, at, theirs = [], dropped = [] } = await planStudent({
        login,
        studentRepo: studentFullName,
        studentTree,
        readTree: readTemplateTree,
        root: () => rootCommit(get, studentFullName, branch),
        repoOrigin: () => repoOrigin(get, studentFullName),
        templateId: Number.isInteger(assignment.template?.repository_id) ? assignment.template.repository_id : null,
        templateFullName,
        headSha: templateSha,
        headTree,
        templateCommits,
        records,
        fallbackSha: parentSha,
        selected: requestedFiles,
        historyComplete: listed.ok && listed.complete,
      });
      if (dropped.length) console.log(`[sync] ${login}: GitHub's copy was short of ${dropped.join(", ")}; planned from ${String(from).slice(0, 7)}`);
      if (theirs.length) console.log(`[sync] ${login}: ${theirs.length} file(s) the template never changed are theirs, not offered: ${theirs.join(", ")}`);
      const outcome = outcomeFor(plan);
      row = syncRow({ login, repoName: studentFullName, teamSlug, outcome, from, source, at, plan });
      for (const e of [...plan.clean, ...plan.conflicts]) appliedPaths.add(e.path);
      const fromNote =
        source === "first-commit"
          ? "from their own first commit - created from a different template"
          : source === "other-template"
            ? `from ${from.slice(0, 7)} of the template this assignment used before`
            : `from ${from ? from.slice(0, 7) : "nothing"}${source === "unknown" ? ", start unknown - this commit only" : ""}`;

      if (outcome === "skipped-up-to-date") {
        console.log(
          plan.kept.length
            ? `[skip] ${login}: already has every change (${fromNote}; ${plan.kept.length} added file(s) already theirs, left alone)`
            : `[skip] ${login}: already has every change (${fromNote})`,
        );
        results.push(row);
        await sleep(200);
        return;
      }

      const toChanges = async (entries) => {
        const out = [];
        for (const { path, action } of entries) {
          // With its MODE: an executable stays executable, a symlink a link.
          out.push(action === "delete"
            ? { path, content: null }
            : { path, content: await contentOf(path), mode: modeOf(headTree.get(path)) });
        }
        return out;
      };

      // 3a. Files the student never touched go straight onto main - unless a
      //     rule of THEIRS refuses it (lib/starter-sync.mjs `isRuleRefusal`: a
      //     ruleset requiring pull requests, which binds this App like anyone
      //     not on its bypass list). Then nothing can land there but a pull
      //     request, and every file goes in it (3b). Tried, not asked of the
      //     rules first: a team that granted PXL Classroom a bypass still
      //     gets the direct commit. Any other refusal is still this student's
      //     failure, as before.
      let mainRefused = null;
      if (plan.clean.length > 0) {
        try {
          const commit = await commitWithRebase({
            token: cfg.token,
            apiBase: process.env.GITHUB_API_URL || undefined,
            owner: cfg.org,
            repo: repoName,
            branch,
            message: `Update starter code from template: ${commitMsgTitle}`,
            changes: await toChanges(plan.clean),
            onNote,
          });
          row.commit_sha = commit.commitSha;
          console.log(`[auto-merged] ${login}: ${plan.clean.length} file(s) -> ${commit.commitSha.slice(0, 7)} (${fromNote})`);
        } catch (err) {
          if (!isRuleRefusal(err)) throw err;
          mainRefused = ruleRefusalReason(err);
          row.outcome = outcomeFor(plan, { mainRefused: true });
          row.main_refused = mainRefused;
          console.log(`[pr] ${login}: their ${branch} only takes pull requests (${mainRefused}) - every file goes in the pull request`);
        }
      }

      // 3b. Files they did touch go onto a branch off THEIR OWN main, so no
      //     foreign SHA is ever involved, and are offered as a pull request -
      //     and every file, where main refused the direct write.
      const offered = filesForPullRequest(plan, mainRefused !== null);
      if (offered.length > 0) {
        // Adopt the pull request a previous run of this same sync already
        // opened. Re-running is the first thing a lecturer does when a sync
        // looks like it did nothing, and without this each run adds another.
        const openPulls = await ghAll(`/repos/${studentFullName}/pulls?state=open&per_page=100`, { token: cfg.token });
        const existing = findExistingSyncPr(openPulls, templateSha);
        if (existing) {
          row.pr_number = existing.number;
          row.pr_url = existing.html_url;
          console.log(`[pr-exists] ${login}: #${existing.number} already open for this update`);
          results.push(row);
          await sleep(300);
          return;
        }

        const branchName = syncBranchName();
        const head = await gh("GET", `/repos/${studentFullName}/git/ref/heads/${encodeURIComponent(branch)}`, null, { token: cfg.token });
        if (!head.ok) throw new Error(`could not read ${branch} (HTTP ${head.status})`);

        const ref = await gh("POST", `/repos/${studentFullName}/git/refs`, {
          ref: `refs/heads/${branchName}`,
          sha: head.data.object.sha,
        }, { token: cfg.token });
        if (!ref.ok) {
          // A "restrict creations" rule of theirs answers "Reference update
          // failed", which names nothing - so the rules for that name are
          // asked (lib/starter-sync.mjs `branchRefusedByRule`). Nothing was
          // created, and the row says what the team can do.
          const rules = ref.status === 422
            ? await gh("GET", `/repos/${studentFullName}/rules/branches/${encodeURIComponent(branchName)}`, null, { token: cfg.token })
            : null;
          if (branchRefusedByRule({ status: ref.status, message: ref.data?.message, rules: rules?.ok ? rules.data : null })) {
            throw new Error(branchRefusedMessage(branchName));
          }
          throw new Error(`could not create ${branchName} (HTTP ${ref.status}${ref.data?.message ? `: ${ref.data.message}` : ""})`);
        }

        await commitWithRebase({
          token: cfg.token,
          apiBase: process.env.GITHUB_API_URL || undefined,
          owner: cfg.org,
          repo: repoName,
          branch: branchName,
          message: `Starter code update: ${commitMsgTitle}`,
          changes: await toChanges(offered),
          onNote,
        });

        const prRes = await gh("POST", `/repos/${studentFullName}/pulls`, {
          title: syncTitle,
          body: `${syncBody}\n\n> Files in this pull request: ${offered.map((c) => `\`${c.path}\``).join(", ")}\n\n${syncMarker(templateSha)}`,
          head: branchName,
          base: branch,
        }, { token: cfg.token });
        if (!prRes.ok) throw new Error(`could not open the sync PR (HTTP ${prRes.status}): ${prRes.data?.message || ""}`);

        row.pr_number = prRes.data.number;
        row.pr_url = prRes.data.html_url;
        console.log(`[pr-opened] ${login}: #${prRes.data.number} for ${offered.length} file(s) (${prRes.data.html_url})`);

        // An OLDER sync's pull request is superseded by this one WHERE THIS ONE
        // CARRIES EVERY FILE IT DID, at a newer version. Left open, the two
        // touched the same files and conflicted (third review, 2026-09-26).
        // Closed only then, and only where it is still only ours: one commit,
        // the sync's own. One the student pushed to is their work and stays;
        // one with a file this range does not reach still offers something.
        // lib/starter-sync.mjs `closeSupersededSyncPrs`, shared with the CLI.
        const superseded = await closeSupersededSyncPrs({
          openPulls,
          newPrNumber: prRes.data.number,
          offered: offered.map((c) => c.path),
          pullDetail: async (n) => {
            const res = await gh("GET", `/repos/${studentFullName}/pulls/${n}`, null, { token: cfg.token });
            return { ok: res.ok, commits: res.data?.commits };
          },
          pullFiles: (n) => ghAll(`/repos/${studentFullName}/pulls/${n}/files?per_page=100`, { token: cfg.token }),
          comment: (n, body) => gh("POST", `/repos/${studentFullName}/issues/${n}/comments`, { body }, { token: cfg.token }),
          close: async (n) => {
            const res = await gh("PATCH", `/repos/${studentFullName}/pulls/${n}`, { state: "closed" }, { token: cfg.token });
            return { ok: res.ok, status: res.status };
          },
        });
        for (const s of superseded) {
          if (s.closed) console.log(`[pr-closed] ${login}: #${s.number} superseded by #${prRes.data.number}`);
          else console.log(`[warn] ${login}: could not close the superseded #${s.number} (HTTP ${s.status})`);
        }
      }

      if (cfg.createIssue) {
        const body = offered.length
          ? `A starter code update is available in Pull Request [#${row.pr_number}](${row.pr_url}). Please review and merge it.`
          : "The starter code in this repository was updated with the latest template changes.\n\nRun `git pull` in your workspace to get them.";
        const issueRes = await gh("POST", `/repos/${studentFullName}/issues`, {
          title: offered.length
            ? `[Action Required] Starter Code Update Available in PR #${row.pr_number}`
            : `[Notice] Starter Code Updated: ${commitMsgTitle}`,
          body,
        }, { token: cfg.token });
        if (issueRes.ok) {
          row.issue_number = issueRes.data.number;
          row.issue_url = issueRes.data.html_url;
          // A SECOND call, so an account that cannot be assigned (removed from
          // the repository, renamed) can never cost the issue itself. What
          // GitHub answers with is who was actually assigned - that, not the
          // list asked for, is what the record keeps.
          const wanted = issueAssignees({ login, repoName: studentFullName, byRepo });
          if (wanted.length) {
            const assignRes = await gh("POST", `/repos/${studentFullName}/issues/${row.issue_number}/assignees`, { assignees: wanted }, { token: cfg.token });
            const { assignees, missed } = assignmentOutcome({ wanted, ok: assignRes.ok, data: assignRes.data });
            row.issue_assignees = assignees;
            if (!assignRes.ok) {
              console.log(`[warn] ${login}: the issue could not be assigned (HTTP ${assignRes.status}) - they are emailed only if they watch the repository`);
            } else if (missed.length) {
              console.log(`[warn] ${login}: could not assign ${missed.join(", ")} - they are emailed only if they watch the repository`);
            }
          }
        } else {
          // The issue IS the notification - without it a student is not told a
          // pull request is waiting for them. Failing it silently left the row
          // reading like a clean sync with no issue number, and the record is
          // what a lecturer reads to see who still needs a second look.
          row.issue_error = `HTTP ${issueRes.status}${issueRes.data?.message ? `: ${issueRes.data.message}` : ""}`;
          console.log(`[warn] ${login}: the notification issue could not be created (${row.issue_error}) - they have not been told`);
        }
      }

      results.push(row);
    } catch (err) {
      // The LOG names the request, its status and how long GitHub took; the
      // row keeps GitHub's words, which are what the lecturer's page shows.
      const detail = requestDetail(err);
      console.log(`[fail] ${login}: ${err.message}${detail ? ` [${detail}]` : ""}`);
      results.push(failedRow(row, err.message));
    }
  }

  // 4. The final record. NOT best effort: this is the one that says the run
  //    finished and how, and a run whose final record did not land goes red.
  //
  //    A ROUND THAT ANOTHER FOLLOWS LEAVES ITS RECORD `running`. The sync as a
  //    whole is still going, in the same run, and `stopped` would tell the
  //    lecturer to press Sync again over a job that is about to carry on. If
  //    the next round never starts, the page finds this record `running` with
  //    its run over and says the sync ended before it finished and how many it
  //    reached (lib/sync-status.mjs), which is then the truth. The next round
  //    writes a record of its own, and the newest record is the one shown.
  const continues = remaining > 0 && cfg.round < cfg.rounds;
  const status = remaining > 0 ? (continues ? "running" : "stopped") : "completed";
  const syncRecord = buildRecord(status, remaining);
  await writeRecord(
    syncRecord,
    continues
      ? `Starter code sync for ${cfg.assignmentId}: round ${cfg.round} of ${cfg.rounds} ended with ${remaining} student(s) to go`
      : status === "stopped"
        ? `Starter code sync for ${cfg.assignmentId} stopped with ${remaining} student(s) to go`
        : `Record starter code sync for ${cfg.assignmentId}`,
  );
  // After the record, never before: a round that could not write where it
  // got to goes red (above) instead of handing over.
  await setOutput("continues", continues ? "true" : "false");

  const s = syncRecord.summary;
  const tail = continues
    ? `, ${remaining} not reached - round ${cfg.round + 1} of ${cfg.rounds} continues`
    : remaining ? `, ${remaining} not reached - run it again` : "";
  console.log(
    `\nSync ${continues ? `round ${cfg.round} of ${cfg.rounds} ended` : status} (${syncId}): ${s.auto_merged} updated in place, ` +
      `${s.pr_opened} pull request(s), ${s.skipped} skipped, ${s.failed} failed${tail}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
