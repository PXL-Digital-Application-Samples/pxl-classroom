import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";
import { parse } from "yaml";

// Helper to sign JWT using Node's crypto
function generateJwt(clientId, privateKeyPem) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: clientId,
  };
  const stringifiedHeader = JSON.stringify(header);
  const stringifiedPayload = JSON.stringify(payload);
  const base64Header = Buffer.from(stringifiedHeader).toString("base64url");
  const base64Payload = Buffer.from(stringifiedPayload).toString("base64url");
  const signatureInput = `${base64Header}.${base64Payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(privateKeyPem, "base64url");
  return `${signatureInput}.${signature}`;
}

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
    jwt = generateJwt(clientId, privateKey);
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
