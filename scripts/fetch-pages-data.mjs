import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
// Shared with scripts/check-installation-approvals.mjs. It was a private helper
// here until a second caller needed it; two copies of a signing routine drift
// into an intermittently invalid credential rather than a visible error.
import { generateAppJwt } from "../lib/app-jwt.mjs";

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
      const contentsUrl = `https://api.github.com/repos/${org}/pxl-classroom-control/contents/public/assignments.json`;
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
          `https://api.github.com/repos/${org}/pxl-classroom-control/git/trees/HEAD?recursive=1`,
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
            `https://api.github.com/repos/${org}/pxl-classroom-control/git/blobs/${entry.sha}`,
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

      // Fetch public/teams/*.json for group assignments
      try {
        const teamsListUrl = `https://api.github.com/repos/${org}/pxl-classroom-control/contents/public/teams`;
        const teamsList = await request(teamsListUrl, {
          headers: { Authorization: `token ${token}` },
        });
        if (Array.isArray(teamsList)) {
          const orgTeamsDir = join(outDir, org, "teams");
          await mkdir(orgTeamsDir, { recursive: true });
          for (const item of teamsList) {
            if (item.type === "file" && item.name.endsWith(".json")) {
              const fileItem = await request(item.url, {
                headers: { Authorization: `token ${token}` },
              });
              if (fileItem?.content) {
                const teamBin = Buffer.from(fileItem.content.replace(/\n/g, ""), "base64").toString("utf8");
                await writeFile(join(orgTeamsDir, item.name), teamBin);
                console.log(`[ok] Saved teams/${item.name} for ${org}`);
              }
            }
          }
        }
      } catch (tErr) {
        if (tErr.status !== 404) {
          console.warn(`[warning] Failed to fetch public/teams for ${org}:`, tErr.message);
        }
      }
    } catch (err) {
      if (err.status === 404) {
        console.log(`[info] No assignments.json found in control repo for ${org} (or repository does not exist).`);
      } else {
        console.error(`[error] Failed to fetch data for ${org}:`, err.message);
      }
    }
  }

  // 5. Generate index.json containing all successfully resolved orgs
  await writeFile(join(outDir, "index.json"), JSON.stringify({ orgs: activeOrgs }, null, 2) + "\n");
  console.log(`[ok] Generated index.json with ${activeOrgs.length} org(s).`);
}

main().catch((err) => {
  console.error("[fail] Critical error in fetch-pages-data:", err);
  process.exit(1);
});
