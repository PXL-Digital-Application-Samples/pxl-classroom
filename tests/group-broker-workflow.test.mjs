import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("publish-assignment.yml creates/edits broker with --enable-issues", () => {
  const content = readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8");
  assert.ok(
    content.includes("--enable-issues"),
    "publish-assignment.yml must enable issues on broker repos for group acceptance payloads"
  );
  assert.ok(
    !content.includes("--disable-issues"),
    "publish-assignment.yml must not disable issues on broker repos"
  );
});

test("broker-workflow.yml triggers on both watch:started and issues:opened", () => {
  const content = readFileSync(join(root, "acceptance", "broker-workflow.yml"), "utf8");
  assert.ok(content.includes("watch:\n    types: [started]"), "broker workflow must handle watch:started for individual");
  assert.ok(content.includes("issues:\n    types: [opened]"), "broker workflow must handle issues:opened for group payload");
});

test("GroupAcceptanceCard.vue validates issue creation response before pending", () => {
  const content = readFileSync(join(root, "frontend", "src", "components", "GroupAcceptanceCard.vue"), "utf8");
  assert.ok(content.includes("if (!issueRes.ok)"), "GroupAcceptanceCard must check issueRes.ok");
  assert.ok(content.includes("Broker repository"), "GroupAcceptanceCard must give helpful 404 message");
});

test("AdminView.vue enables Republish broker button on published assignments without disabling", () => {
  const content = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  assert.ok(content.includes("Republish broker"), "AdminView must offer a Republish broker option");
  assert.ok(
    content.includes('@click="publishExisting" :disabled="publishing"'),
    "Republish button must only be disabled while publishing is in progress, not when form.state === 'published'"
  );
});
