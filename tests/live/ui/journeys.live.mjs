// LIVE: the remaining journeys in the real screens (TV-13 L3, L6, L9, L12).
//
//   COPY_FROM=<a group drill with a team, e.g. one teams.live.mjs made> \
//   DELETE_DRILL=<a finished drill to delete> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs journeys
//
// WRITES: a self-service group assignment and a team in it (STUDENT_A's
// acceptance), a second group assignment with teams copied into it and the
// copy undone, and the deletion of DELETE_DRILL through the Admin Panel's own
// dialog. The ids it makes are printed; delete them with `drill.mjs cleanup`.
import { test, expect } from "@playwright/test";
import { parse } from "yaml";
import { api } from "../live-kit.mjs";
import { ACCOUNTS, ORG, control, publishedData, publishAssignment, signInAs, studentLink } from "./live-ui.mjs";
import { CONTROL_REPO } from "../../../lib/deployment.mjs";
import { brokerRepoName } from "../../../lib/broker-repo.mjs";

const MINUTE = 60_000;
const COPY_FROM = process.env.COPY_FROM;
const DELETE = process.env.DELETE_DRILL;
const shown = (iso, zone) => new Date(iso).toLocaleString("en-GB", {
  timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

test("L6, L3: a student's new team name is refused for an address, a usable one makes their team, and Switch team runs until the deadline", async ({ page }) => {
  test.setTimeout(20 * MINUTE);
  const { id, deadlineAt } = await publishAssignment({
    prefix: "ui-self", title: "Live UI: a team of my own", minutes: 180, pattern: "{team_slug}",
    extra: { assignment_type: "group", group_config: { max_team_size: 3, min_team_size: 1, formation_mode: "self-service", allow_team_creation: true } },
  });
  console.log(`assignment ${id} - delete it with: node tests/live/drill.mjs cleanup ${id}`);
  const doc = parse(await control(`assignments/${id}.yml`));
  await signInAs(page, ACCOUNTS.STUDENT_A);
  await publishedData(page);
  const link = await studentLink(id);
  await expect.poll(async () => {
    await page.goto(link);
    return page.locator(".tab-pill", { hasText: "+ Create New Team" })
      .waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
  }, { timeout: 8 * MINUTE, intervals: [15_000] }).toBe(true);

  await page.locator(".tab-pill", { hasText: "+ Create New Team" }).click();
  const name = page.locator("#new-team-name");
  const create = page.getByRole("button", { name: /Create & Join Team/ });
  await name.fill("ann.dewit@student.pxl.be");
  await expect(page.locator("[data-team-name-problem]")).toContainText("A team name is shown on a public page, so it cannot contain an email address.");
  await expect(create).toBeDisabled();
  await name.fill("Pod Pirates");
  await expect(page.locator("[data-team-name-problem]")).toHaveCount(0);
  await create.click();

  const invited = page.getByRole("heading", { name: "Team repository invitation pending" });
  await expect(invited).toBeVisible({ timeout: 10 * MINUTE });
  // Where a wrong team is first seen, it can be left: until the ASSIGNMENT's
  // deadline, in the page's one date format (T4, D8).
  await expect(page.locator("[data-team-switch]")).toContainText(`You can change team yourself until ${shown(deadlineAt, doc.timezone)}.`);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByRole("heading", { name: "Your team repository is ready!" })).toBeVisible({ timeout: 3 * MINUTE });
  await expect(page.locator("[data-team-switch]")).toContainText(`You can change team yourself until ${shown(deadlineAt, doc.timezone)}.`);
  await expect(page.locator("[data-team-switch]").getByRole("button", { name: "Switch team" })).toBeEnabled();
  const repo = await api(`/repos/${ORG}/${id}-pod-pirates`, { token: ACCOUNTS.LECTURER.token });
  expect(repo.status).toBe(200);
});

test("L12: Copy teams into a new assignment, with the footnote it gives, and Undo copy takes them away again", async ({ page }) => {
  test.skip(!COPY_FROM, "COPY_FROM: a group drill with a team");
  test.setTimeout(15 * MINUTE);
  const source = parse(await control(`assignments/${COPY_FROM}.yml`));
  const { id } = await publishAssignment({
    prefix: "ui-copy", title: "Live UI: teams copied in", minutes: 180, pattern: "{team_slug}",
    extra: { assignment_type: "group", group_config: { max_team_size: 3, min_team_size: 1, formation_mode: "pre-assigned", unassigned_fallback: "block" } },
  });
  console.log(`assignment ${id} - delete it with: node tests/live/drill.mjs cleanup ${id}`);
  await signInAs(page, ACCOUNTS.LECTURER);
  await publishedData(page);
  await page.goto(`/dashboard/${ORG}/${id}?tab=teams`);
  await page.getByRole("button", { name: /Copy (teams|the teams of an earlier assignment)/ }).first().click({ timeout: 2 * MINUTE });
  const modal = page.locator(".seed-modal");
  await modal.locator("#seed-source").selectOption(`assignment:${COPY_FROM}`);
  await expect(modal.locator(".seed-preview-row").first()).toBeVisible({ timeout: MINUTE });
  await expect(modal.locator(".seed-footnote")).toHaveText(
    "The teams are saved now and students see them right away; no repository is created until a student accepts.",
  );
  await modal.locator(".modal-foot .btn-primary").click();
  await expect(page.locator(".toast", { hasText: `into ${"Live UI: teams copied in"}` })).toBeVisible({ timeout: MINUTE });
  await expect(page.locator("tr", { hasText: "Krusty Krabs" })).toBeVisible({ timeout: MINUTE });
  console.log(`copied from "${source.title}"`);

  await page.getByRole("button", { name: /Undo copy/ }).click();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("No student repository is touched.");
  await ask.getByRole("button", { name: /^Remove \d+ teams?$/ }).click();
  await expect(page.locator("tr", { hasText: "Krusty Krabs" })).toHaveCount(0, { timeout: MINUTE });
  const dir = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/teams/${id}`, { token: ACCOUNTS.LECTURER.token });
  expect(dir.status === 404 || (Array.isArray(dir.data) && dir.data.length === 0), "no team files are left").toBe(true);
});

test("L9: delete a finished drill through the Admin Panel's own dialog, and GitHub and the control repository say it is gone", async ({ page }) => {
  test.skip(!DELETE, "DELETE_DRILL: a finished drill to delete");
  test.setTimeout(10 * MINUTE);
  const doc = parse(await control(`assignments/${DELETE}.yml`));
  const report = JSON.parse(await control(`reports/${DELETE}.json`));
  const students = (report.students || []).filter((s) => s.repo_name);
  const broker = brokerRepoName({ assignment: doc, assignmentId: DELETE });
  await signInAs(page, ACCOUNTS.LECTURER);
  await publishedData(page);
  await page.goto(`/dashboard/${ORG}/${DELETE}`);
  const menu = page.locator("[data-state-menu]");
  const item = (text) => page.locator(".state-menu [role=menuitem]").filter({ hasText: text });
  await menu.click({ timeout: MINUTE });
  if (doc.state === "published") {
    // Finished but never closed: Delete waits for Stop accepting, and the menu
    // says what each entry does now - nobody could accept since the deadline,
    // and the lock it would run has run (P2-56).
    await expect(item("Stop accepting")).toContainText("Nobody could accept after the deadline anyway");
    await expect(page.locator(".state-menu")).not.toContainText("Lock everyone out now");
    await item("Stop accepting").click();
    // It runs in the editor, which asks first - in the same words as the menu.
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText("Nobody could accept after the deadline anyway", { timeout: MINUTE });
    await ask.getByRole("button", { name: "Stop accepting" }).click();
    await expect(menu).toContainText("Closed", { timeout: 3 * MINUTE });
    await menu.click();
  }
  await item("Delete assignment").click();
  const dialog = page.locator('[aria-label="Delete assignment"]');
  await expect(dialog).toContainText("Student repositories are untouched");
  await expect(dialog.locator('[data-archive-state="kept"]')).toContainText("The archive is kept.", { timeout: MINUTE });
  await expect(dialog).toContainText(broker);
  const confirm = dialog.getByRole("button", { name: /Delete assignment/ });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Type .* to confirm/).fill(DELETE);
  await confirm.click();
  await expect(page.locator(".toast", { hasText: `Deleted ${DELETE}. Grades and the report are in retired/${DELETE}/.` })).toBeVisible({ timeout: 3 * MINUTE });

  const T = ACCOUNTS.LECTURER.token;
  expect((await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${DELETE}.yml`, { token: T })).status).toBe(404);
  expect((await api(`/repos/${ORG}/${CONTROL_REPO}/contents/retired/${DELETE}/manifest.json`, { token: T })).status).toBe(200);
  expect((await api(`/repos/${ORG}/${broker}`, { token: T })).status).toBe(404);
  for (const s of students) {
    expect((await api(`/repos/${s.repo_name}`, { token: T })).status, `${s.repo_name} is untouched`).toBe(200);
  }
});
