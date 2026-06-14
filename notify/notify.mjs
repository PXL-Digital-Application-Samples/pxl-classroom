#!/usr/bin/env node
// PXL Classroom — instructor notification handler.
//
// Posts or updates an instructor-only tracking issue in the private control
// repo. Deduplicates repeated alerts for the same condition using a dedup key
// embedded in issue comments.
//
// Inputs via env: GITHUB_TOKEN, ORG, CONTROL_REPO, EVENT_TYPE, ASSIGNMENT_ID,
//                 DETAILS, DEDUP_KEY
// Outputs via GITHUB_OUTPUT: outcome

import { appendFile } from "node:fs/promises";

const env = (k, d) => process.env[k] ?? d;

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}

const TRACKING_ISSUE_TITLE = "🔔 PXL Classroom — Instructor Notifications";
const DEDUP_MARKER = "<!-- pxl-dedup:";

const EMOJI_MAP = {
  "provisioning-failed": "❌",
  "collection-failed": "⚠️",
  "deadline-gap": "⏰",
  "missing-access": "🔒",
  "unexpected-deletion": "🗑️",
  "late-activity": "📝",
  "preservation-failed": "💾",
};

async function gh(method, path, body) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pxl-classroom-notify",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { status: res.status, ok: res.ok, data };
}

async function findOrCreateTrackingIssue() {
  // Search for existing tracking issue
  const search = await gh(
    "GET",
    `/repos/${process.env.ORG}/${process.env.CONTROL_REPO}/issues?labels=pxl-tracking&state=open&per_page=1`
  );
  if (search.ok && search.data.length > 0) {
    return search.data[0].number;
  }

  // Create tracking issue
  const create = await gh(
    "POST",
    `/repos/${process.env.ORG}/${process.env.CONTROL_REPO}/issues`,
    {
      title: TRACKING_ISSUE_TITLE,
      body:
        "This issue is automatically managed by PXL Classroom.\n\n" +
        "Significant events are posted as comments. Do not close this issue.\n\n" +
        "---\n\nLabels: `pxl-tracking`",
      labels: ["pxl-tracking"],
    }
  );

  if (!create.ok) {
    console.error(`[FAIL] Could not create tracking issue: HTTP ${create.status}`);
    await setOutput("outcome", "fail:create-issue");
    process.exit(1);
  }

  return create.data.number;
}

async function main() {
  const eventType = env("EVENT_TYPE");
  const assignmentId = env("ASSIGNMENT_ID");
  const details = env("DETAILS", "");
  const dedupKey = env("DEDUP_KEY", "");

  const emoji = EMOJI_MAP[eventType] || "ℹ️";
  const now = new Date().toISOString();

  const issueNumber = await findOrCreateTrackingIssue();

  // Build comment body
  const commentBody =
    `${dedupKey ? `${DEDUP_MARKER}${dedupKey}-->\n` : ""}` +
    `### ${emoji} ${eventType}\n\n` +
    `**Assignment:** ${assignmentId}\n` +
    `**Time:** ${now}\n\n` +
    `${details}\n`;

  // Check for dedup
  if (dedupKey) {
    const comments = await gh(
      "GET",
      `/repos/${process.env.ORG}/${process.env.CONTROL_REPO}/issues/${issueNumber}/comments?per_page=100`
    );
    if (comments.ok) {
      const existing = comments.data.find(
        (c) => c.body && c.body.includes(`${DEDUP_MARKER}${dedupKey}-->`)
      );
      if (existing) {
        // Update existing comment
        await gh(
          "PATCH",
          `/repos/${process.env.ORG}/${process.env.CONTROL_REPO}/issues/comments/${existing.id}`,
          { body: commentBody }
        );
        console.log(`[ok] Updated existing notification (dedup: ${dedupKey})`);
        await setOutput("outcome", "deduplicated");
        return;
      }
    }
  }

  // Post new comment
  const post = await gh(
    "POST",
    `/repos/${process.env.ORG}/${process.env.CONTROL_REPO}/issues/${issueNumber}/comments`,
    { body: commentBody }
  );

  if (!post.ok) {
    console.error(`[FAIL] Could not post comment: HTTP ${post.status}`);
    await setOutput("outcome", "fail:post-comment");
    process.exit(1);
  }

  console.log(`[ok] Posted notification for ${eventType} on ${assignmentId}`);
  await setOutput("outcome", "notified");
}

main().catch(async (e) => {
  console.error(`[FAIL] ${e.message}`);
  await setOutput("outcome", "fail:exception");
  process.exit(1);
});
