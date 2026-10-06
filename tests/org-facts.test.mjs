// lib/org-facts.mjs: what the Organization page says about the organization.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_FACTS, TEACHER_UPGRADE_URL, actionsThisMonth, formatDiskUsage, orgFacts } from "../lib/org-facts.mjs";
import { FREE_PLAN } from "../lib/audit.mjs";

// PXL-Java-Essentials as GitHub answered an owner on 2026-10-06.
const team = {
  plan: { name: "team", seats: 1, filled_seats: 45 },
  default_repository_permission: "read",
  collaborators: 28,
  total_private_repos: 48,
  public_repos: 1,
  disk_usage: 16186,
};

test("a non-owner is told the plan is an owner's to see, and nothing is guessed", () => {
  const f = orgFacts({ org: { public_repos: 15 } });
  assert.equal(f.ownerOnly, true);
  assert.equal(f.plan, null);
  assert.equal(f.repositories, null, "public count alone would read as the whole list");
});

test("Team: what it does for a deadline, in the lecturer's words, with GitHub's numbers", () => {
  const f = orgFacts({ org: team, owners: 3, members: 17 });
  assert.equal(f.plan.name, "GitHub Team");
  assert.match(f.plan.lines.join(" "), /students keep Actions, secrets and settings/);
  assert.match(f.plan.lines.join(" "), /3,000 Actions minutes .* 60 jobs at once/);
  assert.deepEqual(f.plan.more, []);
  assert.equal(f.plan.upgradeUrl, null);
  assert.equal(f.people, "3 owners · 14 other members · 28 outside collaborators (students are added this way)");
  assert.equal(f.membersRead, "Every member can read every repository, the roster included.");
  assert.equal(f.repositories, "48 private and 1 public repositories, 16 MB in all.");
});

test("Free: named plainly, the consequences behind More, with the free upgrade", () => {
  const f = orgFacts({ org: { ...team, plan: { name: FREE_PLAN }, default_repository_permission: "none" } });
  assert.equal(f.plan.name, "GitHub Free");
  assert.deepEqual(f.plan.lines, [], "neutral: nothing said up front");
  assert.match(f.plan.more.join(" "), /read-only instead/);
  assert.match(f.plan.more.join(" "), /2,000 Actions minutes .* 20 jobs at once/);
  assert.equal(f.plan.upgradeUrl, TEACHER_UPGRADE_URL);
  assert.equal(f.membersRead, null, "base permission none says nothing");
});

test("a plan this module does not know is named, and nothing is claimed for it", () => {
  const f = orgFacts({ org: { ...team, plan: { name: "enterprise" } } });
  assert.equal(f.plan.name, "GitHub Enterprise");
  assert.deepEqual([f.plan.lines, f.plan.more, f.plan.upgradeUrl], [[], [], null]);
  assert.deepEqual(Object.keys(PLAN_FACTS).sort(), ["free", "team"]);
});

test("a count that could not be walked whole is left out, never shown as part", () => {
  const f = orgFacts({ org: { ...team, collaborators: null }, owners: null, members: 17 });
  assert.equal(f.people, "17 members");
  assert.equal(orgFacts({ org: { ...team, collaborators: null } }).people, null);
});

test("write or admin as the base permission is said for what it breaks", () => {
  assert.match(orgFacts({ org: { ...team, default_repository_permission: "write" } }).membersRead, /deadline lock cannot stop them/);
});

test("Actions this month: minutes and what was charged, from the billing items", () => {
  const items = [
    { product: "actions", unitType: "Minutes", quantity: 10, netAmount: 0 },
    { product: "actions", unitType: "Minutes", quantity: 9, netAmount: 0 },
    { product: "packages", unitType: "GigabyteHours", quantity: 3, netAmount: 0.5 },
  ];
  assert.deepEqual(actionsThisMonth(items), { minutes: 19, charged: 0 });
  assert.equal(orgFacts({ org: team, billingItems: items }).actions, "19 minutes this month, nothing charged.");
  const charged = [{ product: "actions", unitType: "Minutes", quantity: 4000, netAmount: 6.004 }];
  assert.equal(orgFacts({ org: team, billingItems: charged }).actions, "4,000 minutes this month, $6.00 charged beyond what is included.");
  assert.equal(actionsThisMonth(null), null);
  assert.equal(orgFacts({ org: team }).actions, null, "unread billing says nothing");
});

test("disk usage in a unit a person reads", () => {
  assert.equal(formatDiskUsage(512), "512 KB");
  assert.equal(formatDiskUsage(16186), "16 MB");
  assert.equal(formatDiskUsage(3 * 1024 * 1024), "3.0 GB");
  assert.equal(formatDiskUsage(undefined), null);
});
