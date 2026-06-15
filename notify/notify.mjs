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
import { gh } from "../lib/gh.mjs";

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

export async function notifyEvent({ org, controlRepo, eventType, assignmentId, details, dedupKey }) {
  const emoji = EMOJI_MAP[eventType] || "ℹ️";
  const now = new Date().toISOString();

  // Search for existing tracking issue
  let issueNumber;
  const search = await gh(
    "GET",
    `/repos/${org}/${controlRepo}/issues?labels=pxl-tracking&state=open&per_page=1`
  );
  if (search.ok && search.data.length > 0) {
    issueNumber = search.data[0].number;
  } else {
    // Create tracking issue
    const create = await gh(
      "POST",
      `/repos/${org}/${controlRepo}/issues`,
      {
        title: TRACKING_ISSUE_TITLE,
        body:
          "This issue is automatically managed by PXL Classroom.\n\n" +
          "Significant events are posted as comments. Do not close this issue.\n\n" +
          "---\n\nLabels: `pxl-tracking`",
        labels: ["pxl-tracking"],
      }
    );
    if (!create.ok) throw new Error(`Could not create tracking issue: HTTP ${create.status}`);
    issueNumber = create.data.number;
  }

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
      `/repos/${org}/${controlRepo}/issues/${issueNumber}/comments?per_page=100`
    );
    if (comments.ok) {
      const existing = comments.data.find(
        (c) => c.body && c.body.includes(`${DEDUP_MARKER}${dedupKey}-->`)
      );
      if (existing) {
        // Update existing comment
        await gh(
          "PATCH",
          `/repos/${org}/${controlRepo}/issues/comments/${existing.id}`,
          { body: commentBody }
        );
        return "deduplicated";
      }
    }
  }

  // Post new comment
  const post = await gh(
    "POST",
    `/repos/${org}/${controlRepo}/issues/${issueNumber}/comments`,
    { body: commentBody }
  );

  if (!post.ok) throw new Error(`Could not post comment: HTTP ${post.status}`);
  return "notified";
}

async function main() {
  const eventType = env("EVENT_TYPE");
  const assignmentId = env("ASSIGNMENT_ID");
  const details = env("DETAILS", "");
  const dedupKey = env("DEDUP_KEY", "");
  const org = process.env.ORG;
  const controlRepo = process.env.CONTROL_REPO;

  const outcome = await notifyEvent({ org, controlRepo, eventType, assignmentId, details, dedupKey });
  console.log(`[ok] ${outcome === "deduplicated" ? "Updated existing notification" : "Posted notification"} for ${eventType} on ${assignmentId}`);
  await setOutput("outcome", outcome);
}

// Only run main if executed directly
if (process.argv[1] && process.argv[1].endsWith('notify.mjs')) {
  main().catch(async (e) => {
    console.error(`[FAIL] ${e.message}`);
    await setOutput("outcome", "fail:exception");
    process.exit(1);
  });
}
