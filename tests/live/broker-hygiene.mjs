#!/usr/bin/env node
// PXL Classroom - LIVE broker hygiene check. Not part of `npm test`.
//
//   node tests/live/broker-hygiene.mjs                 every participating org
//   node tests/live/broker-hygiene.mjs PXL-Automation-II   just one
//
// READ ONLY. It creates nothing, changes nothing and needs no test accounts -
// only a token that can see the orgs' control repositories. It exists because
// the invariant it checks is about the state of the WORLD, and the world drifts
// in ways a mock cannot: a nightly that failed months ago, a broker somebody
// republished by hand, an assignment finalized before this check existed.
//
// THE INVARIANT, established 2026-09-03:
//
//   an assignment past its deadline  =>  its broker has INVITE_ENABLED=false
//                                        and holds no PXL_BROKER_* secret
//
// Both halves were false for every assignment ever published. `publish` set
// INVITE_ENABLED=true and the broker App's private key, and nothing ever
// removed either - so a finished exam still booted a runner for any
// `pxl-accept:` issue, and still carried a credential on a PUBLIC repository,
// five days after its deadline. `scripts/close-acceptance.mjs` now does both
// when the nightly finalizes; this is how you find out whether it actually did.
//
// A failure here is not an emergency: the runner is free, the broker App is
// `contents: write` on the hub alone, and the hub refuses a late acceptance
// anyway. It is a door left open, and the point is to notice.




import { parse } from "yaml";
import { gh } from "../../lib/gh.mjs";
import { brokerRepoName } from "../../lib/broker-repo.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../lib/deployment.mjs";



// The same file the hub reads, from the same place - `participating-orgs.yml`
// on the `participating-orgs` BRANCH, not on main, which is why this fetches it
// rather than reading the checkout. A local read would have found nothing and
// reported "no organizations" as cleanly as a real empty list.
async function participatingOrgs() {
  const res = await gh(
    "GET",
    `/repos/${HUB_OWNER}/${HUB_REPO_NAME}/contents/participating-orgs.yml?ref=participating-orgs`,
  );
  if (!res.ok || !res.data?.content) return { ok: res.status === 404, list: [], status: res.status };
  const doc = parse(Buffer.from(res.data.content, "base64").toString("utf8")) ?? {};
  return { ok: true, list: (doc.orgs || []).map((o) => (typeof o === "string" ? o : o.login)).filter(Boolean) };
}

/** Every assignment document in an org's control repo, decoded. */
async function assignments(org) {
  const dir = await gh("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments`);
  if (!dir.ok || !Array.isArray(dir.data)) {
    // UNREADABLE IS NOT EVIDENCE. An org this token cannot see must not be
    // reported as an org with nothing to check.
    return { ok: false, status: dir.status, list: [] };
  }
  const list = [];
  for (const f of dir.data.filter((e) => e.type === "file" && e.name.endsWith(".yml"))) {
    const res = await gh("GET", `/repos/${org}/${CONTROL_REPO}/contents/${f.path}`);
    if (!res.ok || !res.data?.content) continue;
    try {
      list.push(parse(Buffer.from(res.data.content, "base64").toString("utf8")));
    } catch {
      /* a document we cannot parse is reported by the audit, not here */
    }
  }
  return { ok: true, list };
}

let open = 0;
let checked = 0;
let unreadable = 0;

async function checkOrg(org) {
  const { ok, status, list } = await assignments(org);
  if (!ok) {
    console.log(`  ${org}: control repo unreadable (HTTP ${status}) - NOT checked`);
    unreadable++;
    return;
  }

  const now = new Date();
  const past = list.filter((a) => a?.deadline_at && now > new Date(a.deadline_at));
  if (past.length === 0) {
    console.log(`  ${org}: no assignment past its deadline`);
    return;
  }

  for (const a of past) {
    const broker = brokerRepoName({ assignment: a, assignmentId: a.id });
    checked++;

    const v = await gh("GET", `/repos/${org}/${broker}/actions/variables/INVITE_ENABLED`);
    const s = await gh("GET", `/repos/${org}/${broker}/actions/secrets`);

    // A broker that is gone is not a leak; it is the one state that needs no
    // closing. Anything unreadable is reported rather than assumed clean.
    if (v.status === 404 && s.status === 404) {
      console.log(`  ${org}/${broker}: broker absent - nothing to close`);
      continue;
    }

    const enabled = v.ok ? String(v.data?.value).toLowerCase() !== "false" : null;
    const secrets = s.ok ? (s.data?.secrets || []).map((x) => x.name).filter((n) => n.startsWith("PXL_BROKER_")) : null;

    const faults = [];
    if (enabled === null) faults.push(`INVITE_ENABLED unreadable (HTTP ${v.status})`);
    else if (enabled) faults.push("INVITE_ENABLED is still true");
    if (secrets === null) faults.push(`secrets unreadable (HTTP ${s.status})`);
    else if (secrets.length) faults.push(`still holds ${secrets.join(", ")}`);

    if (faults.length === 0) {
      console.log(`  ${org}/${broker}: closed, no credential  (deadline ${a.deadline_at})`);
    } else {
      open++;
      console.log(`  ${org}/${broker}: OPEN - ${faults.join("; ")}  (deadline ${a.deadline_at})`);
    }
  }
}

const only = process.argv[2];
let orgs = only ? [only] : [];
if (!only) {
  const found = await participatingOrgs();
  if (!found.ok) {
    console.error(`Could not read participating-orgs.yml (HTTP ${found.status}) - pass an organization as an argument.`);
    process.exit(2);
  }
  orgs = found.list;
}
if (orgs.length === 0) {
  console.error("No organizations to check - pass one as an argument, or register one.");
  process.exit(2);
}

console.log(`Broker hygiene across ${orgs.length} organization(s)\n`);
for (const org of orgs) await checkOrg(org);

console.log(
  `\n${checked} finished assignment(s) checked, ${open} still open` +
    (unreadable ? `, ${unreadable} organization(s) NOT checked` : ""),
);

// A door left open is a finding. An org that could not be read is not a pass
// and not a failure - it is a gap, and it exits non-zero so a runner notices.
process.exit(open > 0 || unreadable > 0 ? 1 : 0);
