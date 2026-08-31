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

export { CONTROL_REPO };

export async function getAssignment(octokit, { org, assignmentId }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: `assignments/${assignmentId}.yml`,
    });
    const text = Buffer.from(res.data.content, "base64").toString("utf8");
    return yamlParse(text);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`no assignments/${assignmentId}.yml in ${org}/${CONTROL_REPO} yet - make sure the assignment ID is correct and published/draft exists.`);
    }
    throw e;
  }
}

export async function getReport(octokit, { org, assignmentId }) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: `reports/${assignmentId}.json`,
    });
    const text = Buffer.from(res.data.content, "base64").toString("utf8");
    return JSON.parse(text);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`no reports/${assignmentId}.json in ${org}/${CONTROL_REPO} yet - the nightly writes it; trigger 'Run daily activity now' from the assignment page or wait for tonight's run.`);
    }
    throw e;
  }
}

export async function listRepoRecords(octokit, { org, assignmentId }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: `repositories/${assignmentId}`,
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

export async function listTeams(octokit, { org, assignmentId }) {
  let files = [];
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: org, repo: CONTROL_REPO, path: `teams/${assignmentId}`,
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
      owner: org, repo: CONTROL_REPO, path: "students/roster.yml",
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
      owner: org, repo: CONTROL_REPO, path: `acceptances/${assignmentId}`,
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
      owner: org, repo: CONTROL_REPO, path: `acceptances/${assignmentId}`,
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
export async function deleteClaim(octokit, { org, githubId, message }) {
  const removed = [];
  for (const path of [`students/claims/${githubId}.json`, `students/claim-attempts/${githubId}.json`]) {
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
