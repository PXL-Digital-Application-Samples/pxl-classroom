import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
// Shared with scripts/check-installation-approvals.mjs. It was a private helper
// here until a second caller needed it; two copies of a signing routine drift
// into an intermittently invalid credential rather than a visible error.
import { generateAppJwt } from "../lib/app-jwt.mjs";
import { CONTROL_REPO } from "../lib/deployment.mjs";

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "pxl-classroom-fetch-pages-data",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Request to ${url} failed with status ${res.status}: ${errText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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
      const list = await request(`https://api.github.com/app/installations?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
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
  // reason. Not the same as a 404 (nothing published yet) or a missing
  // installation (registered, not installed) - both of those are real answers.
  const failedOrgs = [];

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
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const token = tokenRes.token;

      // Fetch public/assignments.json from the control repo
      const contentsUrl = `https://api.github.com/repos/${org}/${CONTROL_REPO}/contents/public/assignments.json`;
      const fileData = await request(contentsUrl, {
        headers: { Authorization: `token ${token}` },
      });

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
          { headers: { Authorization: `token ${token}` } }
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
            { headers: { Authorization: `token ${token}` } }
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
        if (iErr.status !== 404) {
          console.warn(`[warning] Failed to fetch public/i for ${org}:`, iErr.message);
        }
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
        console.log(`[info] No assignments.json found in control repo for ${org} (or repository does not exist).`);
      } else {
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
}

main().catch((err) => {
  console.error("[fail] Critical error in fetch-pages-data:", err);
  process.exit(1);
});
