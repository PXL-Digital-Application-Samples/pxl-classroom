import { appendFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
// Shared with scripts/check-installation-approvals.mjs. It was a private helper
// here until a second caller needed it; two copies of a signing routine drift
// into an intermittently invalid credential rather than a visible error.
import { generateAppJwt } from "../lib/app-jwt.mjs";
import { CONTROL_REPO } from "../lib/deployment.mjs";
import { gh } from "../lib/gh.mjs";
import { sameLogin } from "../lib/github-login.mjs";

// Through lib/gh.mjs, the one carrier with the one retry policy
// (lib/rate-limit.mjs): a 5xx on a GET, or a rate limit, is asked again with
// backoff before it fails the whole deploy. This script had its own bare
// fetch, so on 2026-10-06, during a GitHub incident, one 504 on one
// organization's index took every organization's student pages down with it
// for a quarter of an hour. It sends the API version too, which it never did.
async function request(url, { method = "GET", token } = {}) {
  const res = await gh(method, url, null, { token });
  if (!res.ok) {
    const said = res.data?.message ?? res.data?.raw ?? "";
    const err = new Error(`Request to ${url} failed with status ${res.status}: ${String(said).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.data;
}

async function main() {
  const clientId = process.env.PXL_APP_CLIENT_ID;
  const privateKey = process.env.PXL_APP_PRIVATE_KEY;

  if (!clientId || !privateKey) {
    console.error("[warning] PXL_APP_CLIENT_ID or PXL_APP_PRIVATE_KEY is missing. Skipping data fetch.");
    process.exit(0);
  }

  // 1. Load participating orgs
  let orgs = [];
  try {
    if (existsSync("participating-orgs.yml")) {
      const text = await readFile("participating-orgs.yml", "utf8");
      const yamlDoc = parse(text);
      orgs = (yamlDoc?.orgs || []).map((o) => o.login);
    }
  } catch (err) {
    console.error("[fail] Failed to load participating-orgs.yml:", err.message);
    process.exit(1);
  }

  if (orgs.length === 0) {
    console.log("[ok] No participating orgs found. Generating empty index.");
    const outDir = "frontend/public/data";
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "index.json"), JSON.stringify({ orgs: [] }, null, 2) + "\n");
    return;
  }

  console.log(`Participating orgs: ${orgs.join(", ")}`);

  // 2. Generate JWT for the GitHub App
  let jwt;
  try {
    jwt = generateAppJwt(clientId, privateKey);
  } catch (err) {
    console.error("[fail] Failed to generate JWT:", err.message);
    process.exit(1);
  }

  // 3. Fetch all installations to map account logins to installation IDs
  const installations = [];
  try {
    let page = 1;
    while (true) {
      const list = await request(`https://api.github.com/app/installations?per_page=100&page=${page}`, { token: jwt });
      if (list.length === 0) break;
      installations.push(...list);
      if (list.length < 100) break;
      page++;
    }
  } catch (err) {
    console.error("[fail] Failed to fetch App installations:", err.message);
    process.exit(1);
  }

  const outDir = "frontend/public/data";
  await mkdir(outDir, { recursive: true });

  const activeOrgs = [];
  // Orgs the App IS installed on that could not be read for an unexpected
  // reason, and that had no earlier pages to keep. Not the same as a 404
  // (nothing published yet) or a missing installation (registered, not
  // installed) - both of those are real answers.
  const failedOrgs = [];
  // Orgs that could not be read and keep the pages the previous deployment
  // published for them (keepPrevious), with why.
  const kept = [];

  // ONE ORGANIZATION MUST NOT STOP EVERY OTHER ONE'S STUDENT PAGES (CLAUDE.md).
  // An org that cannot be read used to fail the whole deploy, so a single
  // org's lasting fault - its owner leaving the control repository out of the
  // App's repository access is the likely one, and it has happened - froze the
  // student pages of every organization until somebody fixed it. The deploy
  // now unpacks the previous deployment into PREVIOUS_SITE_DATA, and an org
  // that cannot be read keeps exactly what that deployment published for it:
  // its own last complete state, never a half-read one. Only an org with no
  // earlier pages to keep still fails the run, as before.
  const previousData = process.env.PREVIOUS_SITE_DATA || "";
  function keepPrevious(org, why) {
    const orgDir = join(outDir, org);
    rmSync(orgDir, { recursive: true, force: true });
    const index = activeOrgs.findIndex((o) => sameLogin(o.login, org));
    if (index !== -1) activeOrgs.splice(index, 1);
    const before = previousData ? join(previousData, org) : "";
    if (!before || !existsSync(join(before, "assignments.json"))) return false;
    cpSync(before, orgDir, { recursive: true });
    activeOrgs.push({ login: org });
    kept.push({ org, why });
    console.log(`::warning::${org} could not be read (${why}): its student pages are kept as the previous deployment published them.`);
    return true;
  }

  // 4. Fetch assignments.json for each participating org
  for (const org of orgs) {
    const inst = installations.find((i) => i.account?.login?.toLowerCase() === org.toLowerCase());
    if (!inst) {
      console.warn(`[warning] App is not installed on org: ${org}. Skipping.`);
      continue;
    }

    console.log(`Fetching public data for org ${org} (installation ID: ${inst.id})...`);
    try {
      // Mint installation token
      const tokenRes = await request(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
        method: "POST",
        token: jwt,
      });
      const token = tokenRes.token;

      // Fetch public/assignments.json from the control repo
      const contentsUrl = `https://api.github.com/repos/${org}/${CONTROL_REPO}/contents/public/assignments.json`;
      const fileData = await request(contentsUrl, { token });

      if (fileData?.content) {
        const bin = Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf8");
        const orgDir = join(outDir, org);
        await mkdir(orgDir, { recursive: true });
        await writeFile(join(orgDir, "assignments.json"), bin);
        console.log(`[ok] Saved assignments.json for ${org}`);
        activeOrgs.push({ login: org });
      }

      // Fetch public/i/*.json - the per-invitation assignment cards and their
      // teams files. Named by the sha256 of the invitation token, so the only
      // way to fetch one is to hold the link (ARCHITECTURE §4.3.3).
      //
      // One Git Trees call, then one blob per file. The Contents API needed a
      // directory listing PLUS a request per entry, on every frontend deploy,
      // for every participating org - and its listing silently caps at 1000
      // entries, which a long-running org's accumulated cards can reach.
      try {
        const orgInviteDir = join(outDir, org, "i");
        const tree = await request(
          `https://api.github.com/repos/${org}/${CONTROL_REPO}/git/trees/HEAD?recursive=1`,
          { token }
        );
        const entries = (tree?.tree || []).filter(
          (e) => e.type === "blob" && e.path.startsWith("public/i/") && e.path.endsWith(".json")
        );
        if (tree?.truncated) {
          console.warn(
            `[warning] ${org}: the git tree came back truncated, so some invitation cards may be missing.`
          );
        }
        if (entries.length) await mkdir(orgInviteDir, { recursive: true });
        let saved = 0;
        for (const entry of entries) {
          const blob = await request(
            `https://api.github.com/repos/${org}/${CONTROL_REPO}/git/blobs/${entry.sha}`,
            { token }
          );
          if (blob?.content) {
            const bin = Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8");
            await writeFile(join(orgInviteDir, entry.path.slice("public/i/".length)), bin);
            saved++;
          }
        }
        // Filenames are digests, so logging them is noise, not information.
        console.log(`[ok] Saved ${saved} invitation file(s) for ${org}`);
      } catch (iErr) {
        // A 404 is an org with no cards yet. Anything else used to be a
        // warning, and the org was published WITHOUT its cards - every
        // invitation link it had handed out answered "not found". It is an
        // org that could not be read, like any other (keepPrevious below).
        if (iErr.status !== 404) throw iErr;
      }

      // `public/teams/` IS NOT FETCHED, and that is the point.
      //
      // pages/generate.mjs deletes it on every regeneration, and says why:
      // "public/teams/ predates the move behind the invitation digest. Anything
      // still there is a public cohort list for an assignment that no longer
      // publishes one." This script used to copy that directory onto the
      // world-readable site - so for any org whose control repo had not
      // regenerated since the retirement, every deploy republished exactly the
      // cohort list the generator exists to remove.
      //
      // pages/scan.mjs does not stop it: it looks for email addresses and
      // invitation-token shapes, and a teams file is `members: ["alice", …]` -
      // GitHub logins, which trip neither rule. Nothing in the SPA reads
      // `data/<org>/teams` either; teams reach a student through the invitation
      // card behind the digest.
    } catch (err) {
      if (err.status === 404) {
        // Nothing published yet - unless the previous deployment had pages for
        // it: then "not found" is far likelier to be lost access (the control
        // repository left out of the App's repository access) than an org that
        // un-published everything, and dropping it would empty every student
        // page it has without a word.
        if (!keepPrevious(org, "answered not found, although it had student pages - check the App's repository access")) {
          console.log(`[info] No assignments.json found in control repo for ${org} (or repository does not exist).`);
        }
      } else if (!keepPrevious(org, `${err.status ?? "no answer"}: ${err.message}`)) {
        console.error(`[error] Failed to fetch data for ${org}:`, err.message);
        failedOrgs.push(`${org}: ${err.message}`);
      }
    }
  }

  // 5. Refuse to publish an index that is missing an org we simply could not
  //    read.
  //
  // index.json is rebuilt from the orgs that succeeded THIS run, and HomeView
  // discovers participating orgs through it - so an org dropped here is an org
  // whose students open the site and see none of their assignments. A transient
  // 500 while minting a token used to do that silently, with the run still
  // exiting 0 and the deploy going ahead.
  //
  // Failing keeps the PREVIOUS Pages deployment live, which is the whole point:
  // yesterday's complete index serves the cohort correctly, and a partial one
  // does not. Unreadable is not evidence that an org has nothing.
  if (failedOrgs.length) {
    console.error(
      `[fail] ${failedOrgs.length} participating org(s) could not be read, so this index would be ` +
        `incomplete and their students would see no assignments. Not publishing; the previous ` +
        `deployment stays live.\n  ${failedOrgs.join("\n  ")}`,
    );
    process.exit(1);
  }

  await writeFile(join(outDir, "index.json"), JSON.stringify({ orgs: activeOrgs }, null, 2) + "\n");
  console.log(`[ok] Generated index.json with ${activeOrgs.length} org(s).`);

  // Said where an administrator is told (scripts/report-kept-orgs.mjs), not
  // only in a log nobody reads: an org kept as it was is an org whose new
  // assignments and changes are not reaching its students.
  if (kept.length && process.env.KEPT_ORGS_FILE) {
    await writeFile(process.env.KEPT_ORGS_FILE, JSON.stringify(kept, null, 2) + "\n");
  }
  if (kept.length && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Student pages kept as last published\n\n${kept.map((k) => `- **${k.org}**: ${k.why}`).join("\n")}\n`,
    );
  }
}

main().catch((err) => {
  console.error("[fail] Critical error in fetch-pages-data:", err);
  process.exit(1);
});
