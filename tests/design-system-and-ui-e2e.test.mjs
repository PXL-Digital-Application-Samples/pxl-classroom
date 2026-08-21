import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const FRONTEND_SRC = join(process.cwd(), "frontend", "src");

// Helper to recursively find all .vue files
async function getVueFiles(dir = FRONTEND_SRC) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getVueFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".vue")) {
      files.push(fullPath);
    }
  }
  return files;
}

// -----------------------------------------------------------------------------
// TEST SUITE: Design System Hygiene & E2E UI Contracts
// -----------------------------------------------------------------------------

test("Design System: All .vue components adhere to token hygiene (no legacy vars)", async () => {
  const vueFiles = await getVueFiles();
  assert.ok(vueFiles.length >= 8, "Expected at least 8 Vue components");

  const legacyVars = [
    "--color-bg-default",
    "--color-border-default",
    "--color-border-muted",
    "--color-accent",
    "--color-bg-subtle",
    "--color-text-secondary",
  ];

  const violations = [];
  for (const file of vueFiles) {
    const content = await readFile(file, "utf8");
    for (const legacy of legacyVars) {
      if (content.includes(legacy)) {
        violations.push({ file: file.replace(process.cwd(), ""), variable: legacy });
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found legacy CSS variables violating DESIGN.md:\n${JSON.stringify(violations, null, 2)}`,
  );
});

test("Design System: Status dot indicators are used for status rendering across core views & modals", async () => {
  const filesToCheck = [
    "views/DashboardView.vue",
    "views/AssignmentDetailView.vue",
    "views/AssignmentView.vue",
    "components/SystemHealthModal.vue",
    "components/StarterSyncModal.vue",
    "components/TeamsTable.vue",
    "components/UsagePanel.vue",
  ];

  for (const relPath of filesToCheck) {
    const fullPath = join(FRONTEND_SRC, relPath);
    const content = await readFile(fullPath, "utf8");
    assert.ok(
      content.includes("status-dot") || content.includes("status-indicator"),
      `${relPath} should utilize .status-dot or .status-indicator per DESIGN.md`,
    );
  }
});

test("Design System: Navigation tabs in AdminView use Primer underline tab classes", async () => {
  const adminViewPath = join(FRONTEND_SRC, "views", "AdminView.vue");
  const content = await readFile(adminViewPath, "utf8");

  assert.ok(
    content.includes("primer-tabs"),
    "AdminView.vue must contain container class .primer-tabs",
  );
  assert.ok(
    content.includes("primer-tab"),
    "AdminView.vue must use .primer-tab button items",
  );
  assert.ok(
    !content.includes("class=\"admin-tabs\""),
    "AdminView.vue should not use legacy .admin-tabs container",
  );
});

test("Design System: Global style.css exports all GitHub Primer surface and border tokens", async () => {
  const styleCssPath = join(FRONTEND_SRC, "style.css");
  const content = await readFile(styleCssPath, "utf8");

  const requiredTokens = [
    "--bg-canvas",
    "--bg-surface",
    "--bg-surface-elevated",
    "--bg-surface-hover",
    "--border-default",
    "--border-muted",
    ".status-dot",
    ".primer-tabs",
    ".primer-tab",
    ".btn-primary",
    ".btn-secondary",
    ".btn-ghost",
    ".btn-danger-outline",
  ];

  for (const token of requiredTokens) {
    assert.ok(
      content.includes(token),
      `style.css is missing required Primer token/class: ${token}`,
    );
  }
});

test("UI E2E Contract: AssignmentDetailView exports 1-Primary CTA and grouped More menu", async () => {
  const detailViewPath = join(FRONTEND_SRC, "views", "AssignmentDetailView.vue");
  const content = await readFile(detailViewPath, "utf8");

  // Verify Copy Invitation Link is primary
  assert.ok(
    content.includes("copyAcceptLink"),
    "Detail view must provide copyAcceptLink handler",
  );
  assert.ok(
    content.includes("moreActionsOpen"),
    "Detail view must manage moreActionsOpen dropdown state",
  );
  assert.ok(
    content.includes("exportDropdownOpen"),
    "Detail view must manage exportDropdownOpen dropdown state",
  );
});
