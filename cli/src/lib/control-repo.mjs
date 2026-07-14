// PXL Classroom CLI — control repo helpers.

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
      throw new Error(`no assignments/${assignmentId}.yml in ${org}/${CONTROL_REPO} yet — make sure the assignment ID is correct and published/draft exists.`);
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
      throw new Error(`no reports/${assignmentId}.json in ${org}/${CONTROL_REPO} yet — the nightly writes it; trigger 'Run daily activity now' from the assignment page or wait for tonight's run.`);
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
