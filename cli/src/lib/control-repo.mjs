// PXL Classroom CLI - control repo helpers.

import { parse as yamlParse } from "yaml";

const CONTROL_REPO = "pxl-classroom-control";

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
