// LIVE: a student's own surfaces, as the real STUDENT_A account, on what the
// other live specs left on the drill org (TV-13 L4, L5). Read only.
//
//   TEAMS_DRILL=<the id teams.live.mjs printed> FINISHED_DRILL=<a verified drill> \
//     npx playwright test --config tests/live/ui/playwright.live.config.mjs student
import { test, expect } from "@playwright/test";
import { parse } from "yaml";
import { api } from "../live-kit.mjs";
import { ACCOUNTS, ORG, control, publishedData, signInAs, studentLink } from "./live-ui.mjs";

const TEAMS = process.env.TEAMS_DRILL;
const FINISHED = process.env.FINISHED_DRILL;
const STUDENT = ACCOUNTS.STUDENT_A;

test("the student home lists a team assignment by its team repository, and an individual one by theirs (L5)", async ({ page }) => {
  test.skip(!TEAMS || !FINISHED, "TEAMS_DRILL and FINISHED_DRILL");
  const [team, individual] = await Promise.all([TEAMS, FINISHED].map(async (id) => parse(await control(`assignments/${id}.yml`))));
  const record = JSON.parse(await control(`repositories/${FINISHED}/${STUDENT.login.toLowerCase()}.json`));
  await signInAs(page, STUDENT);
  await publishedData(page);
  await page.goto("/");
  // By the repository it links to: runs of the same spec share a title.
  const teamCard = page.locator(".my-assignment-card", { hasText: team.title })
    .filter({ has: page.locator(`a[href$="/${ORG}/${TEAMS}-krusty-krabs"]`) });
  await expect(teamCard).toHaveCount(1, { timeout: 90_000 });
  await expect(teamCard.getByRole("link", { name: /Open on GitHub/i })).toBeVisible();
  const ownCard = page.locator(".my-assignment-card", { hasText: individual.title });
  await expect(ownCard.getByRole("link", { name: /Open on GitHub/i })).toHaveAttribute("href", `https://github.com/${record.repo_name}`);
  await expect(page.getByText("No accepted assignments yet")).toHaveCount(0);
});

test("a team repository nobody has pushed to reads 'No commits pushed', never submitted (L4, PG7)", async ({ page }) => {
  test.skip(!TEAMS, "TEAMS_DRILL");
  // The premise, from GitHub: nobody but PXL Classroom has pushed to it.
  const log = await api(`/repos/${ORG}/${TEAMS}-krusty-krabs/activity?per_page=100`, { token: ACCOUNTS.LECTURER.token });
  test.skip(!Array.isArray(log.data) || log.data.some((a) => !/\[bot\]$/.test(a?.actor?.login || "")), "somebody has pushed to it");
  await signInAs(page, STUDENT);
  await publishedData(page);
  await page.goto(await studentLink(TEAMS));
  await expect(page.getByRole("heading", { name: "Your team repository is ready!" })).toBeVisible({ timeout: 90_000 });
  const badge = page.locator(".provisioned-state .badge", { hasText: /Submitted|No commits pushed/ }).first();
  await expect(badge).toHaveText("No commits pushed");
});
