// LIVE: a team renamed before anyone in it accepts, on a real group
// assignment, with a student's page left open across the rename (TV-13 L1, L2;
// lib/team-rename.mjs, ARCHITECTURE on renamed teams).
//
//   npx playwright test --config tests/live/ui/playwright.live.config.mjs teams
//
// WRITES: a fresh group assignment `drill-ui-teams-<stamp>` on the drill org,
// a team, its rename, STUDENT_A's acceptance and their team repository. Delete
// it with `node tests/live/drill.mjs cleanup <id>`; the id is printed.
import { test, expect } from "@playwright/test";
import { api } from "../live-kit.mjs";
import { ACCOUNTS, ORG, publishedData, publishAssignment, signInAs, studentLink } from "./live-ui.mjs";

const STUDENT = ACCOUNTS.STUDENT_A;
const MINUTE = 60_000;

test("rename a team, follow it from a page opened before the rename, and refuse its old name", async ({ browser }) => {
  test.setTimeout(30 * MINUTE);
  const { id } = await publishAssignment({
    prefix: "ui-teams", title: "Live UI: rename a team", minutes: 180, pattern: "{team_slug}",
    extra: {
      assignment_type: "group",
      group_config: { max_team_size: 3, min_team_size: 1, formation_mode: "pre-assigned", unassigned_fallback: "block" },
    },
  });
  console.log(`assignment ${id} - delete it with: node tests/live/drill.mjs cleanup ${id}`);

  const lecturer = await (await browser.newContext()).newPage();
  await signInAs(lecturer, ACCOUNTS.LECTURER);
  await publishedData(lecturer);
  const student = await (await browser.newContext()).newPage();
  await signInAs(student, STUDENT);
  await publishedData(student);

  // 1. The lecturer makes the team, with the student in it.
  await lecturer.goto(`/dashboard/${ORG}/${id}?tab=teams`);
  await lecturer.getByRole("button", { name: /^Create (Team|a team)$/ }).first().click({ timeout: 2 * MINUTE });
  const create = lecturer.getByRole("dialog", { name: /Create a team in/ });
  await create.locator("#create-team-name").fill("Krusty Krab");
  await create.locator(".student-check-item", { hasText: `@${STUDENT.login}` }).locator("input").check();
  await create.getByRole("button", { name: "Create Team" }).click();
  await expect(lecturer.locator("tr", { hasText: "Krusty Krab" })).toBeVisible({ timeout: MINUTE });

  // 2. The student opens their page once the published teams file has them in
  //    it, and leaves it open.
  const link = await studentLink(id);
  // `isVisible` answers at once, before the page has read anything: wait for it.
  await expect.poll(async () => {
    await student.goto(link);
    return student.getByRole("button", { name: /Accept & Join Team/i })
      .waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
  }, { timeout: 8 * MINUTE, intervals: [15_000] }).toBe(true);
  await expect(student.locator("body")).toContainText("Krusty Krab");

  // 3. The lecturer renames it: one commit, the repository it will get shown.
  await lecturer.locator("tr", { hasText: "Krusty Krab" }).getByRole("button", { name: "Manage" }).click();
  const manage = lecturer.locator(".modal.card", { hasText: "Manage Krusty Krab" });
  await manage.getByRole("button", { name: "Rename team" }).click();
  const box = manage.locator("#team-rename-input");
  await expect(box).toBeFocused();
  await box.fill("Krusty Krabs");
  await expect(manage.locator("[data-team-rename]")).toContainText(`${id}-krusty-krabs`);
  await box.press("Enter");
  await expect(lecturer.locator(".toast", { hasText: 'Renamed to "Krusty Krabs"' })).toBeVisible({ timeout: MINUTE });
  await expect(lecturer.locator("tr", { hasText: "Krusty Krabs" })).toBeVisible({ timeout: MINUTE });
  const namesLine = lecturer.locator('[data-note="renamed-served"]');
  await expect(namesLine).toHaveAttribute("data-state", "stale", { timeout: MINUTE });
  await expect(namesLine).toContainText('Students do not see "Krusty Krabs" yet, they see "Krusty Krab"');

  // 4. The student, on the page from before the rename, accepts: the hub takes
  //    the old name as the renamed team and the page follows it.
  await student.getByRole("button", { name: /Accept & Join Team/i }).click();
  // The testbed gives members no base access, so GitHub invites them: the
  // page names the renamed team and the student accepts the invitation there.
  const invited = student.getByRole("heading", { name: "Team repository invitation pending" });
  await expect(invited).toBeVisible({ timeout: 10 * MINUTE });
  await expect(student.locator("body")).toContainText("Team: Krusty Krabs (krusty-krabs)");
  await student.getByRole("button", { name: "Accept invitation" }).click();
  await expect(student.getByRole("heading", { name: "Your team repository is ready!" })).toBeVisible({ timeout: 3 * MINUTE });
  await expect(student.locator(".team-badge-banner")).toContainText("krusty-krabs");
  const repo = await api(`/repos/${ORG}/${id}-krusty-krabs`, { token: ACCOUNTS.LECTURER.token });
  expect(repo.status, "the repository has the new name").toBe(200);
  const old = await api(`/repos/${ORG}/${id}-krusty-krab`, { token: ACCOUNTS.LECTURER.token });
  expect(old.status, "and nothing has the old one").toBe(404);

  // 5. The old name is the renamed team's: a new team may not take it.
  await lecturer.keyboard.press("Escape");
  await lecturer.getByRole("button", { name: /^Create (Team|a team)$/ }).first().click();
  await create.locator("#create-team-name").fill("Krusty Krab");
  await expect(create.locator("[data-new-slug-problem]")).toContainText("was called krusty-krab until it was renamed");
  await expect(create.getByRole("button", { name: "Create Team" })).toBeDisabled();
  await create.getByRole("button", { name: "Cancel" }).click();

  // 6. Now that a member accepted, it cannot be renamed, and says who.
  await lecturer.reload();
  await lecturer.locator("tr", { hasText: "Krusty Krabs" }).getByRole("button", { name: "Manage" }).click({ timeout: MINUTE });
  const after = lecturer.locator(".modal.card", { hasText: "Manage Krusty Krabs" });
  await expect(after.locator("[data-team-rename]")).toContainText("Cannot be renamed:", { timeout: MINUTE });
  await expect(after.getByRole("button", { name: "Rename team" })).toHaveCount(0);
  await lecturer.keyboard.press("Escape");

  // 7. Once the student pages are rebuilt, the line says students see the new name.
  await expect.poll(async () => {
    await namesLine.getByRole("button", { name: "Check again" }).click().catch(() => {});
    return namesLine.getAttribute("data-state").catch(() => null);
  }, { timeout: 8 * MINUTE, intervals: [30_000] }).toBe("current");
  await expect(namesLine).toContainText("Students see every renamed team under its new name.");
});
