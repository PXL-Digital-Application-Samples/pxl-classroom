// PXL Classroom CLI - control repo helpers.
//
// The repository NAME comes from deployment.yml, never a literal. Five files in
// this CLI declared `const CONTROL_REPO = "pxl-classroom-control"` of their own
// while lib/deployment.mjs exported the configured value - so a fork that set
// `control_repo` to anything else got a CLI still talking to PXL's name.
// Relative import rather than `#deployment`: the CLI is its own workspace
// package, so the root package.json's subpath map does not reach here, and the
// CLI is Node-only so the node:fs reader is the right one.

import { parse as yamlParse } from "yaml";
import { CONTROL_REPO } from "../../../lib/deployment.mjs";
import { ROSTER_PATH } from "../../../lib/roster-entries.mjs";
import {
  assignmentPath, gradingSummaryPath, reportPath, repositoriesDir, teamsDir, acceptancesDir, overridesDir,
} from "../../../lib/control-layout.mjs";
import { claimPath, claimAttemptsPath } from "../../../lib/claim.mjs";

export { CONTROL_REPO };

export async function getAssignment(octokit, { org, assignmentId }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: assignmentPath(assignmentId),
    });
    const text = Buffer.from(res.data.content, "base64").toString("utf8");
    return yamlParse(text);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`no assignments/${assignmentId}.yml in ${org}/${CONTROL_REPO} yet - make sure the assignment ID is correct and published/draft exists.`, { cause: e });
    }
    throw e;
  }
}

/**
 * The grading summary on record and its blob sha, or null when there is none.
 * A read that fails for any other reason throws: a summary that could not be
 * read is not "nobody has a score".
 *
 * Read at the branch head's COMMIT, not the branch name: a read by name can be
 * a moment old, and the write's precondition compares the version read with
 * the one at the commit it lands on, so a stale read refused "changed by
 * someone else" when nothing had changed (review 2026-10-14, G13b).
 */
export async function getGradingSummary(octokit, { org, assignmentId }) {
  return readJsonAtHead(octokit, { org, path: gradingSummaryPath(assignmentId) });
}

/**
 * A JSON document in the control repository as it is at the branch head's
 * commit, with its blob sha, or null when there is none. For a write decided
 * from it: read just before, and the write's precondition compares that sha
 * with the one at the commit it lands on.
 */
export async function readJsonAtHead(octokit, { org, path }) {
  const head = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner: org, repo: CONTROL_REPO, ref: "heads/main" });
  const ref = head.data?.object?.sha;
  if (typeof ref !== "string" || !ref) throw new Error(`could not read the head of ${org}/${CONTROL_REPO}`);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path, ref,
    });
    return { doc: JSON.parse(Buffer.from(res.data.content, "base64").toString("utf8")), sha: res.data.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * A `commitWithRebase` precondition: the file at the parent commit is still the
 * version `sha` names (null: still absent). Refuses with `reason` otherwise.
 */
export function unchangedSince(org, path, sha, reason) {
  return async ({ request, parentSha }) => {
    let at = null;
    try {
      at = (await request(`GET /repos/{owner}/{repo}/contents/${path}`, { owner: org, repo: CONTROL_REPO, ref: parentSha })).data?.sha ?? null;
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
    return at === (sha ?? null) ? null : reason;
  };
}

export async function getReport(octokit, { org, assignmentId }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: reportPath(assignmentId),
    });
    const text = Buffer.from(res.data.content, "base64").toString("utf8");
    return JSON.parse(text);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`no reports/${assignmentId}.json in ${org}/${CONTROL_REPO} yet - the nightly writes it; trigger 'Run daily activity now' from the assignment page or wait for tonight's run.`, { cause: e });
    }
    throw e;
  }
}

export async function listRepoRecords(octokit, { org, assignmentId }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: repositoriesDir(assignmentId),
    });
    files = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    if (e.status === 404) {
      return [];
    }
    throw e;
  }
  const records = [];
  for (const f of files) {
    if (f.type !== "file" || !f.name.endsWith(".json")) continue;
    const r = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: f.path,
    });
    const text = Buffer.from(r.data.content, "base64").toString("utf8");
    records.push({ path: f.path, sha: r.data.sha, doc: JSON.parse(text) });
  }
  return records;
}

/**
 * Every `syncs/<id>/*.json`. None is an answer (no sync yet); a record that
 * does not parse is skipped - it can only make a student start EARLIER, from
 * the commit they were generated at, which sends more and never less.
 */
export async function listSyncRecords(octokit, { org, assignmentId }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: `syncs/${assignmentId}`,
    });
    files = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
  const docs = [];
  for (const f of files) {
    if (f.type !== "file" || !f.name.endsWith(".json")) continue;
    try {
      const r = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: org, repo: CONTROL_REPO, path: f.path,
      });
      docs.push(JSON.parse(Buffer.from(r.data.content, "base64").toString("utf8")));
    } catch {
      /* skipped - see above */
    }
  }
  return docs;
}

/**
 * Every `overrides/<id>/<login>.json`. A missing directory is none; any other
 * failure THROWS - unlike the sync records above, where skipping one only
 * sends more. A hand-in allowance that could not be read would grade as if it
 * had never been granted, ignoring the hand-ins a lecturer said should count.
 */
export async function listOverrides(octokit, { org, assignmentId }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: overridesDir(assignmentId),
    });
    files = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
  const docs = [];
  for (const f of files) {
    if (f.type !== "file" || !f.name.endsWith(".json")) continue;
    const r = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: f.path,
    });
    docs.push(JSON.parse(Buffer.from(r.data.content, "base64").toString("utf8")));
  }
  return docs;
}

export async function listTeams(octokit, { org, assignmentId }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: teamsDir(assignmentId),
    });
    files = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
  const teams = [];
  for (const f of files) {
    if (f.type !== "file" || !f.name.endsWith(".json")) continue;
    const r = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: f.path,
    });
    teams.push(JSON.parse(Buffer.from(r.data.content, "base64").toString("utf8")));
  }
  return teams.sort((a, b) => String(a.team_slug).localeCompare(String(b.team_slug)));
}

export async function getRoster(octokit, { org }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: ROSTER_PATH,
    });
    return yamlParse(Buffer.from(res.data.content, "base64").toString("utf8"));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function listAssignments(octokit, { org }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: "assignments",
    });
    files = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
  const docs = [];
  for (const f of files) {
    if (f.type !== "file" || !f.name.endsWith(".yml")) continue;
    const r = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: f.path,
    });
    const doc = yamlParse(Buffer.from(r.data.content, "base64").toString("utf8"));
    docs.push({ ...doc, id: doc.id || f.name.replace(/\.yml$/, "") });
  }
  return docs;
}

/**
 * Full acceptance records for an assignment.
 *
 * listAcceptedLogins below reads only the directory listing, which carries
 * names and no content. Promotion needs `github_id` and `accepted_at`, which
 * live inside each file, so this costs one request per accepted student -
 * acceptable behind an explicit command, the same trade the Feedback PR column
 * makes, and not something to put on a render path.
 */
export async function listAcceptances(octokit, { org, assignmentId }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: acceptancesDir(assignmentId),
    });
    files = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
  const records = [];
  for (const f of files) {
    if (f.type !== "file" || !f.name.endsWith(".json")) continue;
    const r = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: f.path,
    });
    // A record that will not parse is skipped rather than failing the whole
    // promotion: one corrupt file must not strand a cohort of 200.
    try {
      records.push(JSON.parse(Buffer.from(r.data.content, "base64").toString("utf8")));
    } catch {
      records.push({ __unparseable: f.path });
    }
  }
  return records;
}

/** Logins with an acceptance record for an assignment. */
export async function listAcceptedLogins(octokit, { org, assignmentId }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: acceptancesDir(assignmentId),
    });
    return (Array.isArray(res.data) ? res.data : [])
      .filter((f) => f.type === "file" && f.name.endsWith(".json"))
      .map((f) => f.name.replace(/\.json$/, ""));
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

/**
 * Every claim binding in the org, org-scoped rather than per assignment.
 *
 * `unreadable` is returned rather than swallowed, and it is not decoration:
 * anything that DELETES or REWRITES on the strength of this list has to refuse
 * when it is non-empty. Promoting 197 claims and reporting "197 added" over 200
 * files is how three students surface a week later - the rule
 * PromoteRosterModal already carries for acceptances.
 *
 * An absent directory is an answer (nobody has claimed yet); an unreadable one
 * is not, and throws.
 */
export async function listClaims(octokit, { org }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: "students/claims",
    });
    files = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    if (e.status === 404) return { records: [], unreadable: [] };
    throw e;
  }

  const records = [];
  const unreadable = [];
  for (const f of files) {
    if (f.type !== "file" || !f.name.endsWith(".json")) continue;
    try {
      const r = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: org, repo: CONTROL_REPO, path: f.path,
      });
      records.push(JSON.parse(Buffer.from(r.data.content, "base64").toString("utf8")));
    } catch {
      unreadable.push(f.path);
    }
  }
  return { records, unreadable };
}

/**
 * Remove a student's binding so they can claim again.
 *
 * Deletes the ATTEMPT COUNTER as well as the claim, and that is the whole point
 * rather than tidiness: a lecturer unlinks because the binding is wrong, which
 * usually means the student has been failing to claim - and
 * `claimAttemptsExhausted` locks an account out after MAX_CLAIM_ATTEMPTS.
 * Unlinking without clearing it hands the student back a door they still cannot
 * open, and the panel would report them as free to claim.
 *
 * A missing file is success, not an error: unlink has to be re-runnable after a
 * half-completed one, and "there is no binding" is the state being asked for.
 */
/** Delete only the failed-attempt counter; true when there was one. */
export async function resetClaimAttempts(octokit, { org, githubId, message }) {
  return (await deleteControlFiles(octokit, { org, paths: [claimAttemptsPath(githubId)], message })).length > 0;
}

export async function deleteClaim(octokit, { org, githubId, message }) {
  return deleteControlFiles(octokit, { org, paths: [claimPath(githubId), claimAttemptsPath(githubId)], message });
}

async function deleteControlFiles(octokit, { org, paths, message }) {
  const removed = [];
  for (const path of paths) {
    let sha;
    try {
      const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: org, repo: CONTROL_REPO, path,
      });
      sha = res.data?.sha;
    } catch (e) {
      if (e.status === 404) continue;
      throw e;
    }
    if (!sha) continue;
    await octokit.request("DELETE /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path, sha, message,
    });
    removed.push(path);
  }
  return removed;
}
