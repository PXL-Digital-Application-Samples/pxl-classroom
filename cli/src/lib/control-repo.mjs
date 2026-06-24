// PXL Classroom CLI — control repo helpers.

import { parse as yamlParse } from "yaml";

const CONTROL_REPO = "pxl-classroom-control";

export async function getAssignment(octokit, { org, assignmentId }) {
  const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: org, repo: CONTROL_REPO, path: `assignments/${assignmentId}.yml`,
  });
  const text = Buffer.from(res.data.content, "base64").toString("utf8");
  return yamlParse(text);
}

export async function getReport(octokit, { org, assignmentId }) {
  const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: org, repo: CONTROL_REPO, path: `reports/${assignmentId}.json`,
  });
  const text = Buffer.from(res.data.content, "base64").toString("utf8");
  return JSON.parse(text);
}

export async function listRepoRecords(octokit, { org, assignmentId }) {
  const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: org, repo: CONTROL_REPO, path: `repositories/${assignmentId}`,
  });
  const files = Array.isArray(res.data) ? res.data : [];
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
