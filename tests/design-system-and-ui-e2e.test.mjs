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

  // The single primary CTA is still the invitation link, and it is still
  // InvitationShare.vue that presents it - but it is now the popover's TRIGGER
  // that carries btn-primary, not the Copy inside it.
  //
  // The share block used to render as a large unlabelled URL between the tab
  // pills and the table, where a lecturer could not tell what it was (reported
  // 2026-09-02). It is a labelled "Invite link" button opening a popover now.
  // The popover variant exists precisely so its Copy is SECONDARY: the
  // conformity spec counts VISIBLE primaries, so trigger-plus-inline-Copy would
  // put two on screen the moment it opened.
  assert.ok(
    content.includes("<InvitationShare"),
    "Detail view must render the share block",
  );
  assert.match(
    content,
    /<InvitationShare[^>]*variant="popover"/s,
    "the popover variant is the one whose Copy is secondary",
  );
  assert.doesNotMatch(
    content,
    /<InvitationShare[^>]*variant="inline"/s,
    "inline's Copy is btn-primary - with the trigger also primary that is two " +
      "visible primaries, which DESIGN.md §1.2 forbids",
  );
  assert.match(
    content,
    /class="btn btn-primary[^"]*"[^>]*@click\.stop="toggleInviteMenu"/s,
    "and the trigger is this view's one primary CTA",
  );
  assert.ok(
    content.includes("inviteMenuOpen"),
    "Detail view must manage inviteMenuOpen popover state",
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

test("Sandbox E2E: /sandbox route is registered and SandboxView renders offline mock components", async () => {
  const routerPath = join(FRONTEND_SRC, "router", "index.js");
  const routerContent = await readFile(routerPath, "utf8");
  assert.ok(routerContent.includes("path: '/sandbox'"), "Router must register /sandbox route");

  const sandboxViewPath = join(FRONTEND_SRC, "views", "SandboxView.vue");
  const sandboxContent = await readFile(sandboxViewPath, "utf8");

  assert.ok(sandboxContent.includes("StarterSyncModal"), "Sandbox must import StarterSyncModal");
  assert.ok(sandboxContent.includes("SystemHealthModal"), "Sandbox must import SystemHealthModal");
  assert.ok(sandboxContent.includes("TeamsTable"), "Sandbox must import TeamsTable");
  assert.ok(sandboxContent.includes("primer-tabs"), "Sandbox must utilize Primer tabs");
});

