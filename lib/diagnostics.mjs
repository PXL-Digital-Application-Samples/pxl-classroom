// PXL Classroom - Comprehensive Assignment & Organization Diagnostic Engine.
//
// Evaluates an organization and its assignments across a strict 5-tier
// dependency hierarchy. Used by the unified System Health / Diagnostic Modal
// and the CLI audit command.
//
// request(method, path, body) -> { status, ok, data } (Promise)

import { parseYaml } from "./yaml.mjs";
import { parseToken, inviteFileName, linkSecretFrom } from "./invite-token-format.mjs";
import { ACCEPTANCE_KEY_LENGTH } from "./acceptance-signature.mjs";
import {
  APP_INSTALL_URL,
  APP_SLUG,
  CONTROL_REPO,
  HUB_REPO,
  EXPECTED_APP_PERMISSIONS,
  CONTROL_SCAFFOLD_DIRS,
  missingManifestPermissions,
  permissionMeetsRequirement,
  pickClassroomInstallation,
  baseRepositoryPermissionFinding,
  unfreezableAcceptorsFinding,
} from "./audit.mjs";
// Two questions, not one. `claim` gates on the roster too, but it looks the
// student up by EMAIL - so a check counting github_login warns a lecturer about
// a column their cohort deliberately does not use. See lib/roster-mode.mjs.
import { rosterGatesAcceptance, rosterMatchesLogin } from "./roster-mode.mjs";
import { ROSTER_PATH } from "./roster-entries.mjs";
import { rosterBindings, orphanClaims, claimSummary, BINDING_STATES } from "./claim-bindings.mjs";
import { normalizeEmail } from "./claim.mjs";

const SCAFFOLD_PATHS = ["README.md", ...CONTROL_SCAFFOLD_DIRS];

const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, fail: 3 };
const worse = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

function check(id, tierId, label, severity, message, detail = null, fixAction = null) {
  return { id, tierId, label, severity, message, detail, fixAction };
}

function atobSafe(b64) {
  const compact = String(b64).replace(/\n/g, "");
  if (typeof atob === "function") {
    return new TextDecoder().decode(Uint8Array.from(atob(compact), (c) => c.charCodeAt(0)));
  }
  return Buffer.from(compact, "base64").toString("utf8");
}


// Verifies the four-way agreement an invitation depends on: the assignment holds
// a token, the hub holds the key it was signed with, the broker holds the nonce
// it carries, and acceptance is switched on. Any mismatch rejects every student
// with no trace in the control repo (ARCHITECTURE 4.3.2).
export async function runInvitationChecks({ req, addCheck, check, doc, org, brokerName, assignmentId, fromEditor = false }) {
  const TIER = "tier-4-broker";
  const republish = { type: "publish_broker", label: "Republish Assignment" };

  // linkSecretFrom: a migrated assignment's link is invite_key, an unmigrated
  // one is still invite_token, and every surface must agree which.
  const token = linkSecretFrom(doc);

  // ...but the two are checked differently, and conflating them was a false
  // FAIL on every migrated assignment: `parseToken` only knows the `<35>.<86>`
  // token shape, so a 184-character key came back null and the engine reported
  // "invite_token is malformed. Republish to mint a valid one." over a working
  // link - then RETURNED, so the nonce, the switch and everything below it went
  // unchecked as well. A diagnostic that is wrong about a healthy assignment is
  // worse than one that is missing.
  const migrated = Boolean(doc.invite_key);

  // Before anything else, and independent of what the assignment currently
  // holds: a leftover acceptance issue is worth reporting whether the
  // invitation in the YAML is present, absent or malformed. WHAT it means
  // depends on `migrated` - a published credential on the old format, a failed
  // cleanup on the new one - which is why that is passed in. The one case that
  // stays silent is an unsaved editor form with no invitation, which is not yet
  // a fact about the world.
  if (token || !fromEditor) {
    await checkForExposedInvitations({ req, addCheck, check, org, brokerName, TIER, migrated });
  }

  if (!token) {
    // An unsaved Admin Panel form has no invitation yet - publish is what mints
    // one - so this is only a fault for state already persisted and published.
    // Alarming a lecturer about a draft they are still editing is noise.
    // An editor form that carries no token tells us nothing: the invitation is
    // minted at publish and only loaded into the form for an existing
    // assignment. Staying silent beats asserting either way.
    if (fromEditor) return;
    addCheck(
      4,
      check(
            "invite-token",
            TIER,
            "Signed Invitation Link",
            "fail",
        `assignments/${assignmentId}.yml has no invite_token, so no invitation link exists and the student page cannot resolve. An assignment published before signed invitations needs one republish to mint it.`,
        null,
        republish
      )
    );
    return;
  }

  if (migrated) {
    // A PKCS#8 P-256 export is a fixed size, so anything else is a hand-edited
    // or truncated field rather than a key.
    if (token.length !== ACCEPTANCE_KEY_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
      addCheck(
        4,
        check(
          "invite-token",
          TIER,
          "Signed Invitation Link",
          "fail",
          `invite_key is not a usable acceptance key (${token.length} characters, expected ${ACCEPTANCE_KEY_LENGTH}). Republish to mint a valid one.`,
          null,
          republish
        )
      );
      return;
    }
    addCheck(
      4,
      check("invite-token", TIER, "Signed Invitation Link", "ok", "A signed-acceptance keypair is recorded for this assignment.")
    );
    // No hub key file is involved here: the broker verifies against the
    // assignment's OWN public half, mirrored to it as INVITE_PUBKEY. That
    // comparison lives with the other broker variables below.
  } else {
    const parsed = parseToken(token);
    if (!parsed?.canonical) {
      addCheck(
        4,
        check(
          "invite-token",
          TIER,
          "Signed Invitation Link",
          "fail",
          "invite_token is malformed. Republish to mint a valid one.",
          null,
          republish
        )
      );
      return;
    }

    addCheck(
      4,
      check("invite-token", TIER, "Signed Invitation Link", "ok", "A signed invitation is recorded for this assignment.")
    );

    // The broker verifies against the hub's key file. A token signed with a key
    // that is not published there is rejected as unknown-key, every time. This
    // governs the LEGACY token only - a migrated assignment's acceptance keypair
    // is per assignment and never appears in invite-keys.json.
    const kid = String(parsed.payload.kid);
    const keysRes = await req("GET", `/repos/${HUB_REPO}/contents/acceptance/invite-keys.json`);
    if (keysRes.ok) {
      let known = false;
      try {
        const raw = keysRes.data?.content ? atobSafe(keysRes.data.content) : keysRes.data?.raw || "{}";
        const keys = JSON.parse(raw);
        known = Boolean((keys.keys || keys)[kid]);
      } catch {
        known = false;
      }
      addCheck(
        4,
        known
          ? check("invite-key", TIER, "Invitation Signing Key", "ok", `The hub publishes the public key (kid ${kid}) this invitation was signed with.`)
          : check(
              "invite-key",
              TIER,
              "Invitation Signing Key",
              "fail",
              `This invitation is signed with key id ${kid}, which is not in the hub's acceptance/invite-keys.json. Every acceptance will be rejected as unknown-key. Add the public key to the hub, or republish after rotating.`,
              null,
              republish
            )
      );
    } else {
      addCheck(
        4,
        check("invite-key", TIER, "Invitation Signing Key", "info", `Skipped - could not read the hub's invite-keys.json (HTTP ${keysRes.status}).`)
      );
    }
  }

  // The nonce is what retires superseded links. If the YAML and the broker
  // variable diverge - a republish whose variable write failed, say - every
  // link in circulation reports superseded and nobody can accept.
  const varsRes = await req("GET", `/repos/${org}/${brokerName}/actions/variables`);
  if (varsRes.ok && Array.isArray(varsRes.data?.variables)) {
    const vars = Object.fromEntries(varsRes.data.variables.map((v) => [v.name, v.value]));
    const expected = String(doc.invite_nonce || "").toLowerCase();
    const actual = String(vars.INVITE_NONCE || "").toLowerCase();

    if (migrated) {
      // The one agreement a migrated assignment actually rests on, and nothing
      // was checking it. The broker takes the signed path only when it HAS a
      // public key; a republished broker sends no legacy token at all, so a
      // missing INVITE_PUBKEY does not degrade to the old behaviour - it
      // rejects every student, silently, with the control repo none the wiser.
      const wantPubkey = String(doc.invite_pubkey || "").trim();
      const gotPubkey = String(vars.INVITE_PUBKEY || "").trim();
      if (!gotPubkey) {
        addCheck(
          4,
          check(
            "invite-pubkey",
            TIER,
            "Acceptance Public Key (INVITE_PUBKEY)",
            "fail",
            `${brokerName} has no INVITE_PUBKEY variable, so it cannot verify a single acceptance. Republish to set it.`,
            null,
            republish
          )
        );
      } else if (wantPubkey && gotPubkey !== wantPubkey) {
        addCheck(
          4,
          check(
            "invite-pubkey",
            TIER,
            "Acceptance Public Key (INVITE_PUBKEY)",
            "fail",
            `${brokerName} holds a different acceptance key from the one this assignment's link was minted with. Every acceptance will be rejected as a bad signature. Republish to bring them back into step.`,
            null,
            republish
          )
        );
      } else {
        addCheck(
          4,
          check("invite-pubkey", TIER, "Acceptance Public Key (INVITE_PUBKEY)", "ok", "The broker holds this assignment's acceptance key.")
        );
      }
      // The nonce is deliberately NOT judged here. The signed path does not
      // read it, so a divergence costs nothing - and reporting a failure the
      // system does not have is how a health panel stops being trusted.
    } else if (String(vars.INVITE_PUBKEY || "").trim()) {
      // THE INVERSE, and it is worse than the missing-key case, because
      // everything else about the assignment looks healthy.
      //
      // publish-assignment.yml sets INVITE_PUBKEY and pushes the broker's
      // workflow in one step, and commits the assignment afterwards. A failure
      // in between - an org ruleset rejecting the push is the one that has
      // actually happened here - leaves the broker verifying signatures for an
      // assignment whose keypair was never committed. Republishing an
      // already-published assignment does not even revert, because that step
      // only runs for one that was not published before.
      //
      // The broker then takes the signed path, the student's link is still the
      // older bearer kind, and every acceptance is refused as `legacy-link`.
      // The token, the key id and the nonce all still check out, so nothing
      // else here would say a word.
      addCheck(
        4,
        check(
          "invite-pubkey",
          TIER,
          "Acceptance Public Key (INVITE_PUBKEY)",
          "fail",
          `${brokerName} is set up to verify signed acceptances, but this assignment has no keypair - so every link in circulation is the older kind and every acceptance will be refused as out of date. Republish to mint one.`,
          null,
          republish
        )
      );
    } else if (!actual) {
      addCheck(
        4,
        check("invite-nonce", TIER, "Invitation Generation (INVITE_NONCE)", "fail", `${brokerName} has no INVITE_NONCE variable, so it cannot accept any invitation. Republish to set it.`, null, republish)
      );
    } else if (expected && actual !== expected) {
      addCheck(
        4,
        check(
          "invite-nonce",
          TIER,
          "Invitation Generation (INVITE_NONCE)",
          "fail",
          `${brokerName} expects nonce ${actual} but the current invitation carries ${expected}. Every link in circulation will be rejected as superseded. Republish to bring them back into step.`,
          null,
          republish
        )
      );
    } else {
      addCheck(
        4,
        check("invite-nonce", TIER, "Invitation Generation (INVITE_NONCE)", "ok", "The broker's nonce matches the current invitation.")
      );
    }

    // Evaluated in the workflow's job-level `if`, so a disabled broker skips
    // without allocating a runner - and without leaving anything to find.
    if (String(vars.INVITE_ENABLED || "").toLowerCase() === "false") {
      addCheck(
        4,
        check(
          "invite-enabled",
          TIER,
          "Acceptance Switch (INVITE_ENABLED)",
          "warn",
          `Acceptance is switched off on ${brokerName} (INVITE_ENABLED=false). Students opening the link will see nothing happen. Set it to true to reopen.`
        )
      );
    }
  } else {
    addCheck(
      4,
      check("invite-nonce", TIER, "Invitation Generation (INVITE_NONCE)", "info", `Skipped - could not read ${brokerName} variables (HTTP ${varsRes.status}).`)
    );
  }

}

// A trigger issue's TITLE carries the signed invitation, and the broker is
// public - so a leftover one is this assignment's link, published, searchable,
// to anyone who looks. The handler deletes them; this catches the cases where
// it could not: the App lacking `administration: write`, INVITE_ENABLED=false
// skipping the job before cleanup, or a run that died mid-flight.
//
// Titles are matched, not fetched into anything: naming the issue number is
// enough for a lecturer to go and delete it.
// Pages are walked until one comes back short, because this check's "ok" is a
// statement about EVERY issue on the broker. `per_page=100` alone read one
// page and then said "no acceptance issue is carrying an invitation" - a
// confident all-clear on a security control, from a list that stopped at a
// hundred. A cohort of 200 opens 200 acceptance issues, and the cases this
// check exists for are exactly the ones where the handler failed to delete
// them, so "more than a hundred" is the expected shape of a real finding.
const EXPOSURE_PAGE_CAP = 20; // 2,000 issues; beyond that, say so rather than guess.

async function checkForExposedInvitations({ req, addCheck, check, org, brokerName, TIER, migrated = false }) {
  const issues = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const res = await req(
      "GET",
      `/repos/${org}/${brokerName}/issues?state=all&per_page=100&page=${page}`
    );
    if (!res.ok || !Array.isArray(res.data)) {
      addCheck(
        4,
        check("invite-exposure", TIER, "Invitation Exposure", "info", `Skipped - could not list ${brokerName} issues (HTTP ${res.status}).`)
      );
      return;
    }
    issues.push(...res.data);
    if (res.data.length < 100) break;
    if (page >= EXPOSURE_PAGE_CAP) {
      truncated = true;
      break;
    }
  }

  // A BROKER IS A PUBLIC REPOSITORY WITH ISSUES ENABLED, so anybody with a
  // GitHub account can open one on it - that is not a flaw, it is the trigger
  // mechanism. What had no owner was everything that lands there and is NOT an
  // acceptance: the job-level `if` skips those before a runner is allocated
  // (deliberately - see acceptance/broker-workflow.yml), so nothing redacts,
  // closes or even notices them.
  //
  // Found live 2026-08-31 on PXL-2TIN-CloudEssentials-2627/broker-test-
  // groepsopdracht-2: two issues, open, unlocked, months old, one carrying a
  // student's GitHub login in its body. Harmless individually; the point is
  // that a PXL-branded public repository accumulates whatever anyone writes
  // into it and no one is looking.
  //
  // SURFACED RATHER THAN AUTO-CLOSED, on purpose. Closing them from the broker
  // would mean running a job for every issue that is not an acceptance, which
  // trades away the deliberate "a non-acceptance costs no runner at all"
  // property and hands anyone a way to make runs happen on demand. A sweep
  // costs nothing extra here - it reads the list this check already fetched -
  // and puts the answer where a lecturer is already looking.
  //
  // Never a `fail`: a stray issue is untidy, not an outage, and a permanent red
  // beside real findings is how a health panel stops being read.
  const stray = issues.filter(
    (i) => i?.state === "open" && typeof i?.title === "string" && !i.title.startsWith("pxl-accept:")
  );
  addCheck(
    4,
    stray.length === 0
      ? check(
          "broker-stray-issues",
          TIER,
          "Broker Issue Hygiene",
          truncated ? "warn" : "ok",
          truncated
            ? `No stray issue in the first ${EXPOSURE_PAGE_CAP * 100} on ${brokerName}, but there are more than that and they were not all read.`
            : `No stray issues on ${org}/${brokerName} - every open issue is an acceptance.`
        )
      : check(
          "broker-stray-issues",
          TIER,
          "Broker Issue Hygiene",
          "warn",
          `${stray.length} open issue(s) on the PUBLIC repository ${org}/${brokerName} are not acceptances (${stray
            .slice(0, 5)
            .map((i) => `#${i.number}`)
            .join(", ")}${stray.length > 5 ? ", …" : ""}). Anyone can open an issue there - that is how acceptance is triggered - but nothing closes what is not one, so whatever people write stays publicly readable under a PXL repository, and issue bodies from the acceptance flow can carry a student's GitHub login. Read them and close them; if they are being used as a support channel, point students at the assignment page instead.`
        )
  );

  const exposed = issues.filter((i) => typeof i?.title === "string" && i.title.startsWith("pxl-accept:"));
  if (exposed.length === 0) {
    // An all-clear is only honest over a complete list. Having stopped at the
    // cap, the most that can be said is "none in the ones we read".
    addCheck(
      4,
      truncated
        ? check(
            "invite-exposure",
            TIER,
            "Invitation Exposure",
            "warn",
            `None of the first ${EXPOSURE_PAGE_CAP * 100} issues on ${brokerName} carries an invitation, but there are more than that and they were not all read. Check the repository's issue list directly.`
          )
        : check("invite-exposure", TIER, "Invitation Exposure", "ok", `No acceptance issue on ${brokerName} is carrying an invitation in its title.`)
    );
    return;
  }

  const numbers = exposed.slice(0, 5).map((i) => `#${i.number}`).join(", ");
  const more = exposed.length > 5 ? ", …" : "";

  // WHAT A LEFTOVER TITLE IS depends on whether this assignment has migrated,
  // and the two need different words and different advice.
  //
  // On the old format the title IS the invitation - a bearer credential, public,
  // and the right answer is to regenerate. On the signed format it is a
  // signature naming one account, useless to anyone else, so calling it an
  // exposed link would be false and the advice actively harmful: regenerating
  // retires every student's link to fix nothing. The cleanup still failed, and
  // that is worth saying - but not by guessing why.
  //
  // This comment used to blame "an App without `administration: write`", and
  // that diagnosis is FALSE. An installation token cannot delete an issue at
  // ANY permission level: measured live 2026-08-26 in two organizations that
  // both grant the App `administration: write`, `deleteIssue` answered
  // {"type":"FORBIDDEN","message":"Viewer not authorized to delete"}. It is
  // not a permission, which is why the hub's delete step was removed outright
  // and why tests/invite-exposure.test.mjs now fails if anything calls
  // deleteIssue again. The same false lead was cleaned out of ARCHITECTURE
  // §4.3.2, RUNBOOK §3.12 and the acceptance-handler warning; it survived
  // here.
  //
  // What a leftover actually means: the BROKER redacts the title itself with
  // `gh issue edit --title` (needing only `issues: write`), so an unredacted
  // title means that step did not run - and the reason is in the broker's own
  // acceptance-trigger run, not in anything the hub did.
  addCheck(
    4,
    migrated
      ? check(
          "invite-exposure",
          TIER,
          "Invitation Exposure",
          "warn",
          `${exposed.length} acceptance issue(s) on ${org}/${brokerName} were never cleaned up (${numbers}${more}). Since this assignment uses signed acceptance the titles are signatures, not links, so nothing is exposed - this is tidying, not an incident. The broker redacts the title itself, so an unredacted one means that step did not run - the reason is in ${brokerName}'s own acceptance-trigger run for each issue. Deleting them is manual: an installation token cannot delete an issue at any permission level. Do NOT regenerate the invitation: it would retire every student's link and fix nothing.`
        )
      : check(
          "invite-exposure",
          TIER,
          "Invitation Exposure",
          "fail",
          `${exposed.length} issue(s) on the PUBLIC repository ${org}/${brokerName} still carry this assignment's invitation token in their title (${numbers}${more}). Anyone can read it there, so the link is effectively public. Delete those issues, then regenerate the invitation so the exposed one stops working.`
        )
  );
}

export async function runDiagnostics({
  request,
  org,
  assignmentId = null,
  formDoc = null,
  hubOwner = null,
  hubRepo = null,
  fetchPages = null,
  probeProxy = null,
}) {
  if (typeof request !== "function") throw new Error("runDiagnostics requires a request(method, path) function");
  if (!org) throw new Error("runDiagnostics requires an org");

  const tiers = [
    {
      id: "tier-0-auth",
      label: "Authentication & Quota",
      subtitle: "GitHub user session and API rate-limit headroom",
      severity: "ok",
      checks: [],
    },
    {
      id: "tier-1-org",
      label: "Course Organization & GitHub App",
      subtitle: "Provisioner App installation, permissions, and hub enrollment",
      severity: "ok",
      checks: [],
    },
    {
      id: "tier-2-control",
      label: "Course Control Repository",
      subtitle: `Private repository (${CONTROL_REPO}) storing assignments and rosters`,
      severity: "ok",
      checks: [],
    },
  ];

  if (assignmentId || formDoc) {
    tiers.push(
      {
        id: "tier-3-assignment",
        label: "Assignment & Starter Template",
        subtitle: "Assignment YAML schema, roster file, starter template repository, and whether the cohort can be frozen",
        severity: "ok",
        checks: [],
      },
      {
        id: "tier-4-broker",
        label: "Student Acceptance Broker",
        subtitle: "Automated provisioning service repository (broker-<id>) and trigger workflow",
        severity: "ok",
        checks: [],
      },
      {
        id: "tier-5-pages",
        label: "Student Portal & Web Edge",
        subtitle: "Public assignment compilation and GitHub Pages CDN reachability",
        severity: "ok",
        checks: [],
      }
    );
  } else {
    tiers.push(
      {
        id: "tier-3-assignments-overview",
        label: "Registered Assignments",
        subtitle: "Scanned assignment configurations in the control repository",
        severity: "ok",
        checks: [],
      }
    );
  }

  const req = async (method, path, body = null) => {
    try {
      const res = await request(method, path, body);
      return res || { status: 500, ok: false, data: { message: "No response" } };
    } catch (e) {
      return { status: 500, ok: false, error: e.message, data: { message: e.message } };
    }
  };

  const allChecks = [];
  const addCheck = (tierIdx, c) => {
    tiers[tierIdx].checks.push(c);
    tiers[tierIdx].severity = worse(tiers[tierIdx].severity, c.severity);
    allChecks.push(c);
  };

  // The six tiers, in order. Each is a function below: they were one 1,345-line
  // function, separated only by banner comments. The state that genuinely
  // crosses a boundary is threaded explicitly - `doc` from the assignment tier,
  // and the broker's name from the broker tier - so what is shared is visible
  // instead of implied by scope.
  const ctx = { req, addCheck, org, assignmentId, formDoc, hubOwner, hubRepo, fetchPages, probeProxy };

  // Two tiers can end the run: an invalid token and a missing control repo
  // both make every later check noise about a deployment nobody can read.
  // They used to `return finishDiagnostics(...)` from the middle of this
  // function; they report `done` now and this is where the run stops.
  const finish = () => finishDiagnostics(org, assignmentId, tiers, allChecks);

  const auth = await checkAuthTier(ctx);
  if (auth?.done) return finish();
  await checkOrgAppTier(ctx);
  if ((await checkControlRepoTier(ctx))?.done) return finish();
  const { doc } = await checkAssignmentTier(ctx, { viewerLogin: auth.viewerLogin });
  const { isPublished, brokerName } = await checkBrokerTier(ctx, { doc });
  await checkPagesTier(ctx, { doc, isPublished, brokerName });

  return finish();
}

/**
 * Authentication & API quota - tier 0.
 *
 * Lifted out of runDiagnostics verbatim. That function ran to 1,345 lines, and
 * nothing about it was hard except finding anything in it - the six tiers were
 * already separated by banner comments and shared almost no state. What they do
 * share is the context bag below plus, between tiers 3 and 5, the assignment
 * document and the broker's name; those are parameters and return values now
 * rather than 400 lines of shared scope.
 */
async function checkAuthTier({ req, addCheck, org, assignmentId, formDoc, hubOwner, hubRepo, fetchPages, probeProxy }) {
  // ---------------------------------------------------------------------------
  // TIER 0: Authentication & API Quota
  // ---------------------------------------------------------------------------
  let tokenValid = true;
  const userRes = await req("GET", "/user");
  if (!userRes.ok) {
    tokenValid = false;
    // req() reports a THROWN request as a synthetic HTTP 500 carrying `error`
    // - a stalled connection or a request that timed out. That is a transport
    // failure, not a rejected credential, and saying "sign in again" sends the
    // lecturer to re-authenticate a session that was never the problem. Tier 0
    // gates every later tier, so a wrong verdict here mislabels the whole run.
    const transportError = userRes.error;
    addCheck(
      0,
      check(
        "auth-session",
        "tier-0-auth",
        "GitHub Session & User Token",
        "fail",
        transportError
          ? `Could not reach GitHub: ${transportError}. Check your connection, then re-run.`
          : `GitHub session is invalid or expired (HTTP ${userRes.status}). Sign in again.`,
        null,
        transportError ? null : { type: "login", label: "Sign in with GitHub" }
      )
    );
  } else {
    addCheck(
      0,
      check(
        "auth-session",
        "tier-0-auth",
        "GitHub Session & User Token",
        "ok",
        `Authenticated as @${userRes.data?.login || "user"}.`
      )
    );
  }

  // THE ONE DEPENDENCY THAT IS NOT api.github.com.
  //
  // Sign-in cannot reach github.com/login/* directly - those endpoints send no
  // CORS headers at all - so it goes through a proxy, and since 2026-08-31 the
  // primary is a PXL-owned Cloudflare Worker (ARCHITECTURE §10.2.1). Nothing
  // watched it. A Worker outage is invisible until somebody tries to sign in,
  // which for a lecturer is five minutes before a lecture and for a student is
  // at the accept button.
  //
  // The Worker also lives in a single-owner Cloudflare account, so "it silently
  // stopped existing" is a real failure mode rather than a hypothetical one.
  //
  // It runs only when the caller supplies a prober, because this module is
  // imported by tests and by Node, and a check that makes an unrequested
  // network call from a unit run is worse than no check. Absent prober = no
  // check, never a green one - the same rule Tier 1 applies to /apps/{slug}.
  if (typeof probeProxy === "function") {
    let proxy = null;
    try {
      proxy = await probeProxy();
    } catch (err) {
      proxy = { ok: false, detail: String(err?.message || err) };
    }
    if (proxy && proxy.configured === false) {
      addCheck(
        0,
        check(
          "device-flow-proxy",
          "tier-0-auth",
          "Sign-in Proxy",
          "fail",
          `No usable device-flow proxy is configured, so nobody can sign in. Set device_flow_proxy in deployment.yml on the hub, then redeploy the frontend - the value is baked into the bundle at build time, so it does not take effect until the build runs.`
        )
      );
    } else if (proxy && proxy.ok === false) {
      // A WARN, not a fail: there are two proxies and the second one covers
      // this, so sign-in may well be working while the primary is down. Saying
      // "sign-in is broken" when it is not is how a health panel loses its
      // reader - but a silently-spent fallback is exactly what left the third
      // party on the path of every sign-in for as long as it did.
      addCheck(
        0,
        check(
          "device-flow-proxy",
          "tier-0-auth",
          "Sign-in Proxy",
          "warn",
          `The primary sign-in proxy did not answer${proxy.detail ? ` (${proxy.detail})` : ""}. Sign-in falls back to the secondary, so it probably still works - but the fallback is a third party that sees the token in transit, so this is worth fixing rather than living with. Check the Worker named by device_flow_proxy in deployment.yml is deployed and answering.`
        )
      );
    } else if (proxy) {
      addCheck(
        0,
        check("device-flow-proxy", "tier-0-auth", "Sign-in Proxy", "ok", `The PXL sign-in proxy answered.`)
      );
    }
  }

  const rateRes = await req("GET", "/rate_limit");
  if (rateRes.ok && rateRes.data?.resources?.core) {
    const core = rateRes.data.resources.core;
    const remaining = core.remaining;
    const resetMins = core.reset
      ? Math.max(1, Math.ceil((new Date(core.reset * 1000).getTime() - Date.now()) / 60000))
      : 60;
    if (remaining < 100) {
      addCheck(
        0,
        check(
          "api-rate-limit",
          "tier-0-auth",
          "GitHub API Rate Limit",
          remaining === 0 ? "fail" : "warn",
          `Only ${remaining} GitHub API calls remaining (resets in ${resetMins} min).`
        )
      );
    } else {
      addCheck(
        0,
        check(
          "api-rate-limit",
          "tier-0-auth",
          "GitHub API Rate Limit",
          "ok",
          `${remaining} / ${core.limit} API calls available.`
        )
      );
    }
  }

  if (!tokenValid) {
    return { done: true };
  }

  // WHO IS ASKING, for tier 3's `unfreezableAcceptorsFinding` - the check that
  // spots an acceptor who is an org OWNER, whom lockdown cannot demote. It read
  // `userRes` straight out of this tier's scope, 1,000 lines away; threaded as a
  // value now, because that is the only kind of sharing a reader can see.
  return { viewerLogin: userRes.data?.login || null };
}

/**
 * Organization & GitHub App foundation - tier 1.
 *
 * Lifted out of runDiagnostics verbatim. That function ran to 1,345 lines, and
 * nothing about it was hard except finding anything in it - the six tiers were
 * already separated by banner comments and shared almost no state. What they do
 * share is the context bag below plus, between tiers 3 and 5, the assignment
 * document and the broker's name; those are parameters and return values now
 * rather than 400 lines of shared scope.
 */
async function checkOrgAppTier({ req, addCheck, org, assignmentId, formDoc, hubOwner, hubRepo, fetchPages, probeProxy }) {
  // ---------------------------------------------------------------------------
  // TIER 1: Organization & GitHub App Foundation
  // ---------------------------------------------------------------------------
  let installation = null;
  let installationFromUserToken = false;

  // The manifest only applies at App creation. An App that predates a manifest
  // permission never gains it, and no org can approve what the App does not
  // declare - so check the App itself first and name the one person who can
  // act. GET /apps/{slug} needs no authentication.
  let declaredPerms = null;
  const appRes = await req("GET", `/apps/${APP_SLUG}`);
  if (appRes.ok) {
    declaredPerms = appRes.data?.permissions || {};
    const undeclared = missingManifestPermissions(declaredPerms);
    if (undeclared.length === 0) {
      addCheck(
        1,
        check(
          "app-declaration",
          "tier-1-org",
          "GitHub App Declaration",
          "ok",
          "The App declares every permission in the manifest."
        )
      );
    } else {
      const labels = undeclared
        .map((u) => `${u.permission}=${u.actual ?? "missing"} (want ${u.expected})`)
        .join(", ");
      addCheck(
        1,
        check(
          "app-declaration",
          "tier-1-org",
          "GitHub App Declaration",
          "fail",
          `The App itself does not declare: ${labels}. No organization can approve a permission the App does not declare - the App owner adds it under Permissions & events, then every org owner approves the update.`,
          { undeclared },
          {
            type: "link",
            url: `https://github.com/settings/apps/${APP_SLUG}/permissions`,
            label: "Open App Permissions",
          }
        )
      );
    }
  } else if (appRes.status === 404) {
    // The App itself does not exist. Every other check below is downstream of
    // it, so this is the one thing worth saying - and it is the only moment
    // anybody discovers they need /setup, which is the App Manifest form and
    // had no inbound link from anywhere in the app (ARCHITECTURE §10.4.1 / UX18).
    //
    // A 404 is specifically "no such App", not "we could not ask": any other
    // failure (network, rate limit, an unauthenticated read GitHub declined)
    // stays silent, because a false alarm here sends someone to create a
    // SECOND App and split the installation base in half.
    addCheck(
      1,
      check(
        "app-declaration",
        "tier-1-org",
        "GitHub App Declaration",
        "fail",
        `No GitHub App named \`${APP_SLUG}\` exists. Nothing can be provisioned until one is created from the App Manifest form and its credentials are stored as hub secrets. This is a one-time setup a system administrator does.`,
        { appSlug: APP_SLUG, missing: true },
        { type: "navigate_view", name: "setup", label: "Open App setup" }
      )
    );
  }

  const userInsts = await req("GET", "/user/installations");
  if (userInsts.ok && Array.isArray(userInsts.data?.installations)) {
    installation = userInsts.data.installations.find(
      (i) => i.account?.login?.toLowerCase() === org.toLowerCase()
    );
    installationFromUserToken = Boolean(installation);
  }
  if (!installation) {
    const orgInsts = await req("GET", `/orgs/${org}/installations`);
    // Shared with lib/audit.mjs, and shared because these two had already
    // drifted: this one read the response as a bare array, which it is not,
    // so the fallback never ran at all.
    if (orgInsts.ok) installation = pickClassroomInstallation(orgInsts.data);
  }
  if (!installation) {
    const singleInst = await req("GET", `/orgs/${org}/installation`);
    if (singleInst.ok) installation = singleInst.data;
  }

  if (installation) {
    addCheck(
      1,
      check(
        "app-installed",
        "tier-1-org",
        "GitHub App Installation",
        "ok",
        `App installed on ${org} (Installation ID: ${installation.id}).`
      )
    );

    if (installation.repository_selection && installation.repository_selection !== "all") {
      addCheck(
        1,
        check(
          "app-repository-access",
          "tier-1-org",
          "App Repository Access",
          "fail",
          `The installation is scoped to selected repositories. Student repositories do not exist yet at install time, so the App cannot see them once provisioned - set Repository access to "All repositories".`,
          { repository_selection: installation.repository_selection },
          {
            type: "link",
            url: `https://github.com/organizations/${org}/settings/installations/${installation.id}`,
            label: "Set Repository Access",
          }
        )
      );
    } else if (installation.repository_selection === "all") {
      addCheck(
        1,
        check("app-repository-access", "tier-1-org", "App Repository Access", "ok", "Installed on all repositories.")
      );
    }

    const actualPerms = installation.permissions || {};
    const drift = [];
    for (const [perm, expected] of Object.entries(EXPECTED_APP_PERMISSIONS)) {
      const got = actualPerms[perm];
      if (!permissionMeetsRequirement(got, expected)) {
        drift.push({
          permission: perm,
          expected,
          actual: got ?? null,
          upstream: declaredPerms ? !permissionMeetsRequirement(declaredPerms[perm], expected) : false,
        });
      }
    }

    // A declared permission can still be unusable when an installation has
    // not accepted an update or the organization lacks enhanced billing.
    // Probe with the App user token when available so System Health reports
    // the exact failure that would otherwise make weekly usage silently skip.
    if (installationFromUserToken && permissionMeetsRequirement(actualPerms.organization_administration, "read")) {
      const now = new Date();
      const billingRes = await req(
        "GET",
        `/organizations/${encodeURIComponent(org)}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`
      );
      if (billingRes.ok) {
        addCheck(
          1,
          check(
            "billing-usage-access",
            "tier-1-org",
            "Enhanced Billing Usage API",
            "ok",
            "Weekly usage reporting can read organization billing data."
          )
        );
      } else {
        addCheck(
          1,
          check(
            "billing-usage-access",
            "tier-1-org",
            "Enhanced Billing Usage API",
            "fail",
            `Billing usage is inaccessible (HTTP ${billingRes.status}). Confirm Organization Administration: read, approve the App update, and verify enhanced billing is enabled.`,
            { status: billingRes.status, message: billingRes.data?.message || null },
            {
              type: "link",
              url: `https://github.com/organizations/${org}/settings/installations/${installation.id}`,
              label: "Review App Installation",
            }
          )
        );
      }
    }
    if (drift.length === 0) {
      addCheck(
        1,
        check(
          "app-permissions",
          "tier-1-org",
          "GitHub App Permissions",
          "ok",
          "All expected repository and organization permissions are active."
        )
      );
    } else {
      const labels = drift.map((d) => `${d.permission}=${d.actual ?? "missing"}`).join(", ");
      const upstream = drift.filter((d) => d.upstream);
      const appFirst =
        upstream.length && upstream.length === drift.length
          ? " Blocked upstream - the App does not declare it, so there is nothing to approve here yet. Fix the App first (see GitHub App Declaration)."
          : upstream.length
            ? ` ${upstream.map((d) => d.permission).join(", ")} must additionally be added to the App itself first.`
            : "";
      addCheck(
        1,
        check(
          "app-permissions",
          "tier-1-org",
          "GitHub App Permissions",
          "fail",
          `App permissions drifted (${labels}). Re-approve the App permissions.${appFirst}`,
          { drift },
          {
            type: "link",
            url: `https://github.com/organizations/${org}/settings/installations/${installation.id}`,
            label: "Re-approve App Permissions",
          }
        )
      );
    }
  } else {
    addCheck(
      1,
      check(
        "app-installed",
        "tier-1-org",
        "GitHub App Installation",
        "fail",
        `PXL Classroom Provisioner App is not installed on ${org}.`,
        null,
        {
          type: "link",
          url: APP_INSTALL_URL,
          label: "Install GitHub App",
        }
      )
    );
  }

  // Check Hub Registry
  if (hubOwner && hubRepo) {
    const orgsRes = await req("GET", `/repos/${hubOwner}/${hubRepo}/contents/participating-orgs.yml?ref=participating-orgs`);
    if (orgsRes.ok) {
      try {
        const raw = orgsRes.data?.content ? atobSafe(orgsRes.data.content) : (orgsRes.data?.raw || "");
        const parsed = parseYaml(raw);
        const entry = (parsed.orgs || []).find((o) => o.login?.toLowerCase() === org.toLowerCase());
        if (entry) {
          addCheck(
            1,
            check(
              "hub-registry",
              "tier-1-org",
              "Course Organization Enrollment (participating-orgs.yml)",
              "ok",
              `Registered in hub (Budget owner: @${entry.budget_owner_login || "unknown"}).`
            )
          );
        } else {
          addCheck(
            1,
            check(
              "hub-registry",
              "tier-1-org",
              "Course Organization Enrollment (participating-orgs.yml)",
              "fail",
              `${org} is missing from participating-orgs.yml. Run Setup Organization to register.`,
              null,
              { type: "setup_org", label: "Run Setup Organization" }
            )
          );
        }
      } catch (e) {
        addCheck(
          1,
          check(
            "hub-registry",
            "tier-1-org",
            "Course Organization Enrollment (participating-orgs.yml)",
            "warn",
            `Could not parse participating-orgs.yml: ${e.message}`
          )
        );
      }
    } else {
      addCheck(
        1,
        check(
          "hub-registry",
          "tier-1-org",
          "Course Organization Enrollment (participating-orgs.yml)",
          "warn",
          "participating-orgs.yml not found on the central hub repository."
        )
      );
    }
  }

  // The organization's base repository permission. Read from GET /orgs/{org},
  // which only returns the field to an org admin (or a token carrying
  // organization_administration) - so an absent value means "could not see it",
  // never "it is fine", and produces no check at all rather than a false
  // all-clear. Same rule the App-declaration checks above follow.
  {
    const orgRes = await req("GET", `/orgs/${org}`);
    const finding = orgRes.ok
      ? baseRepositoryPermissionFinding(orgRes.data?.default_repository_permission, { org })
      : null;
    if (finding) {
      addCheck(
        1,
        check(
          "org-base-permission",
          "tier-1-org",
          "Organization Base Repository Permission",
          finding.severity,
          finding.message,
          finding.severity === "ok"
            ? null
            : { permission: finding.permission, settings_url: `https://github.com/organizations/${org}/settings/member_privileges` }
        )
      );
    }
  }

}

/**
 * Control repository foundation - tier 2.
 *
 * Lifted out of runDiagnostics verbatim. That function ran to 1,345 lines, and
 * nothing about it was hard except finding anything in it - the six tiers were
 * already separated by banner comments and shared almost no state. What they do
 * share is the context bag below plus, between tiers 3 and 5, the assignment
 * document and the broker's name; those are parameters and return values now
 * rather than 400 lines of shared scope.
 */
async function checkControlRepoTier({ req, addCheck, org, assignmentId, formDoc, hubOwner, hubRepo, fetchPages, probeProxy }) {
  // ---------------------------------------------------------------------------
  // TIER 2: Control Repository Foundation
  // ---------------------------------------------------------------------------
  let controlRepoOk = false;
  const ctrlRes = await req("GET", `/repos/${org}/${CONTROL_REPO}`);
  if (ctrlRes.status === 404) {
    addCheck(
      2,
      check(
        "control-repo",
        "tier-2-control",
        `Control Repository Exists (${CONTROL_REPO})`,
        "fail",
        `${org}/${CONTROL_REPO} does not exist. Run Setup Organization to initialize your course repository.`,
        null,
        { type: "setup_org", label: "Run Setup Organization" }
      )
    );
  } else if (!ctrlRes.ok) {
    addCheck(
      2,
      check(
        "control-repo",
        "tier-2-control",
        `Control Repository Exists (${CONTROL_REPO})`,
        "warn",
        `Could not read ${CONTROL_REPO} (HTTP ${ctrlRes.status}).`
      )
    );
  } else {
    if (!ctrlRes.data.private) {
      addCheck(
        2,
        check(
          "control-repo-privacy",
          "tier-2-control",
          "Control Repository Privacy (Private)",
          "fail",
          `${CONTROL_REPO} is public! It must be private to safeguard student rosters and grades.`
        )
      );
    } else {
      controlRepoOk = true;
      addCheck(
        2,
        check(
          "control-repo",
          "tier-2-control",
          "Control Repository Exists & Private",
          "ok",
          `${org}/${CONTROL_REPO} exists and is private.`
        )
      );
    }

    const missingPaths = [];
    for (const p of SCAFFOLD_PATHS) {
      const r = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/${p}`);
      if (r.status === 404) missingPaths.push(p);
    }
    if (missingPaths.length > 0) {
      addCheck(
        2,
        check(
          "control-scaffold",
          "tier-2-control",
          "Control Repository Scaffold",
          "warn",
          `Missing scaffold directories: ${missingPaths.join(", ")}.`,
          { missing: missingPaths }
        )
      );
    } else {
      addCheck(
        2,
        check(
          "control-scaffold",
          "tier-2-control",
          "Control Repository Scaffold",
          "ok",
          "All standard scaffold folders (assignments, reports, public, etc.) exist."
        )
      );
    }
  }

  // If no specific assignment is targeted, perform Org-level assignments scan
  if (!assignmentId && !formDoc) {
    if (controlRepoOk) {
      const listRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments`);
      if (listRes.ok && Array.isArray(listRes.data)) {
        const ymlFiles = listRes.data.filter((f) => f.name.endsWith(".yml") || f.name.endsWith(".yaml"));
        addCheck(
          3,
          check(
            "assignments-scan",
            "tier-3-assignments-overview",
            "Registered Assignments",
            "ok",
            `Found ${ymlFiles.length} assignment configuration(s) in ${org}/${CONTROL_REPO}.`
          )
        );
      } else {
        addCheck(
          3,
          check(
            "assignments-scan",
            "tier-3-assignments-overview",
            "Registered Assignments",
            "ok",
            "No assignments found in control repository yet."
          )
        );
      }
    }
    return { done: true };
  }

}

/**
 * Assignment definition & starter template - tier 3.
 *
 * Lifted out of runDiagnostics verbatim. That function ran to 1,345 lines, and
 * nothing about it was hard except finding anything in it - the six tiers were
 * already separated by banner comments and shared almost no state. What they do
 * share is the context bag below plus, between tiers 3 and 5, the assignment
 * document and the broker's name; those are parameters and return values now
 * rather than 400 lines of shared scope.
 */
async function checkAssignmentTier({ req, addCheck, org, assignmentId, formDoc, hubOwner, hubRepo, fetchPages, probeProxy }, { viewerLogin }) {
  // ---------------------------------------------------------------------------
  // TIER 3: Assignment Definition & Starter Template
  // ---------------------------------------------------------------------------
  let doc = formDoc ? { ...formDoc } : null;
  if (doc) {
    if (!doc.opens_at && doc.opens_at_local) {
      try { doc.opens_at = new Date(doc.opens_at_local).toISOString(); } catch { /* ignore */ }
    }
    if (!doc.deadline_at && doc.deadline_at_local) {
      try { doc.deadline_at = new Date(doc.deadline_at_local).toISOString(); } catch { /* ignore */ }
    }
  }

  if (!doc && assignmentId) {
    const ymlRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments/${assignmentId}.yml`);
    if (ymlRes.ok) {
      try {
        const raw = ymlRes.data?.content ? atobSafe(ymlRes.data.content) : (ymlRes.data?.raw || "");
        doc = parseYaml(raw);
      } catch (e) {
        addCheck(
          3,
          check(
            "assignment-yaml",
            "tier-3-assignment",
            "Assignment YAML Syntax",
            "fail",
            `assignments/${assignmentId}.yml has syntax errors: ${e.message}`
          )
        );
      }
    } else if (ymlRes.status === 404) {
      addCheck(
        3,
        check(
          "assignment-yaml",
          "tier-3-assignment",
          "Assignment Configuration File",
          "fail",
          `assignments/${assignmentId}.yml not found in control repository.`
        )
      );
    }
  }

  if (doc) {
    const missingFields = [];
    if (!doc.title) missingFields.push("title");

    let tplString = "";
    if (doc.template) {
      if (typeof doc.template === "object" && doc.template.owner && doc.template.repository) {
        tplString = `${doc.template.owner}/${doc.template.repository}`;
      } else if (typeof doc.template === "string") {
        tplString = doc.template;
      }
    }
    if (!tplString) missingFields.push("template");

    if (!doc.repository_name_pattern) missingFields.push("repository_name_pattern");
    if (!doc.opens_at) missingFields.push("opens_at");
    if (!doc.deadline_at) missingFields.push("deadline_at");

    if (missingFields.length > 0) {
      addCheck(
        3,
        check(
          "assignment-fields",
          "tier-3-assignment",
          "Required Assignment Fields",
          "fail",
          `Missing required fields: ${missingFields.join(", ")}.`
        )
      );
    } else {
      addCheck(
        3,
        check(
          "assignment-fields",
          "tier-3-assignment",
          "Assignment Configuration Fields",
          "ok",
          `Title: "${doc.title}", State: "${doc.state || "draft"}".`
        )
      );
    }

    if (tplString && tplString.includes("/")) {
      const [tplOwner, tplRepo] = tplString.split("/");
      const tplRes = await req("GET", `/repos/${tplOwner}/${tplRepo}`);
      if (tplRes.status === 404) {
        addCheck(
          3,
          check(
            "template-repo",
            "tier-3-assignment",
            "Starter Template Repository Exists",
            "fail",
            `Template repository "${tplString}" does not exist on GitHub or is not accessible.`
          )
        );
      } else if (!tplRes.ok) {
        addCheck(
          3,
          check(
            "template-repo",
            "tier-3-assignment",
            "Starter Template Repository Exists",
            "warn",
            `Could not read template repository ${tplString} (HTTP ${tplRes.status}).`
          )
        );
      } else {
        addCheck(
          3,
          check(
            "template-repo",
            "tier-3-assignment",
            "Starter Template Repository Exists",
            "ok",
            `Template "${tplString}" exists and is accessible.`
          )
        );

        if (tplRes.data.is_template === true) {
          addCheck(
            3,
            check(
              "template-is-template",
              "tier-3-assignment",
              "Starter Template Setting (is_template on GitHub)",
              "ok",
              `Repository "${tplString}" is marked as a Template Repository on GitHub.`
            )
          );
        } else {
          addCheck(
            3,
            check(
              "template-is-template",
              "tier-3-assignment",
              "Starter Template Setting (is_template on GitHub)",
              "fail",
              `"${tplString}" exists, but is NOT marked as a Template repository on GitHub. Check "Template repository" under repo Settings.`,
              null,
              {
                type: "mark_template",
                owner: tplOwner,
                repo: tplRepo,
                label: `Mark ${tplRepo} as Template on GitHub`,
              }
            )
          );
        }
      }
    }

    // The roster is org-wide at students/roster.yml - what accept.mjs actually
    // reads. This checked rosters/<id>.csv, a path the data model has never had,
    // so it told lecturers their roster was missing when it was not. It also
    // only fired on an explicit "enforced"; absent means enforced too (ARCHITECTURE §15.1).
    //
    // The guard was `roster_mode !== "open"`, which CLAUDE.md already records as
    // the wrong spelling everywhere else: it collapses every roster-gated mode
    // into one. With `claim` that stopped being cosmetic - a claim assignment
    // got a check headed "Enforced Roster" telling the lecturer that students
    // without a `github_login` "cannot accept until theirs is added", when
    // under `claim` the student supplies the binding themselves and that column
    // is precisely the one the mode exists to avoid needing. Describing
    // behaviour the system does not have (C4), on the one panel a stuck
    // lecturer opens.
    if (rosterGatesAcceptance(doc.roster_mode) && assignmentId) {
      // Which field is the gate. Everything below that counts, names or blames
      // a field has to ask this rather than the mode.
      const byLogin = rosterMatchesLogin(doc.roster_mode);
      const rosterRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/${ROSTER_PATH}`);
      if (rosterRes.status === 404) {
        addCheck(
          3,
          check(
            "roster-check",
            "tier-3-assignment",
            `${byLogin ? "Enforced" : "Claim"} Roster File (${ROSTER_PATH})`,
            "warn",
            `roster_mode is ${byLogin ? "enforced" : "claim"}, but ${ROSTER_PATH} was not found. Every acceptance will be rejected as rejected:no-roster until a roster is imported.`,
            null,
            { type: "navigate_roster", label: "Open Roster Editor" }
          )
        );
      } else if (rosterRes.ok) {
        // "The file exists" is not the question. The question is whether
        // anybody can accept, and three different rosters answer no while
        // existing perfectly well:
        //
        //   * `students: []` - the scaffold stub. This is what stranded
        //     2526-examen-aut2-ek2 in July: every acceptance rejected
        //     not-on-roster, zero accepted, and nothing said why.
        //   * no `students:` key at all - a hand-edited array-shaped roster
        //     parses fine, and accept.mjs reads `roster?.students || []`, so
        //     it sees an empty roster and rejects everyone.
        //   * students with no `github_login` - the optional CSV column, and
        //     the ONLY field accept.mjs matches on. A roster imported before
        //     students handed in their usernames lets nobody accept while
        //     reporting a healthy count (the same rule RosterTab's
        //     `linkedCount` exists for).
        //
        // The old branch reported `ok` for all three - and named
        // `rosters/<id>.csv`, a path the data model has never had. The comment
        // above records that being fixed in the REQUEST; the success message
        // kept it, so a lecturer was sent looking for a file that cannot exist.
        const label = `${byLogin ? "Enforced" : "Claim"} Roster (${ROSTER_PATH})`;
        // Published means students may be trying right now, so it is not a
        // warning about future work.
        const sev = doc.state === "published" ? "fail" : "warn";
        const fix = { type: "navigate_roster", label: "Open Roster Editor" };

        let parsed = null;
        try {
          const raw = rosterRes.data?.content ? atobSafe(rosterRes.data.content) : rosterRes.data?.raw;
          parsed = raw ? parseYaml(raw) : null;
        } catch {
          parsed = undefined; // unreadable, as distinct from empty
        }

        if (parsed === undefined) {
          addCheck(3, check("roster-check", "tier-3-assignment", label, "warn",
            `${ROSTER_PATH} exists but could not be parsed as YAML, so it is not possible to say who may accept. Re-import the roster.`));
        } else if (!Array.isArray(parsed?.students)) {
          addCheck(3, check("roster-check", "tier-3-assignment", label, sev,
            `${ROSTER_PATH} has no \`students:\` list. Acceptance reads that key and nothing else, so every acceptance is rejected as not-on-roster. Re-import the roster from the Roster tab.`,
            null, fix));
        } else {
          const students = parsed.students;
          // The gate field, and the words for it. Under `claim` the roster is
          // looked up by ADDRESS (accept.mjs step 7, "the roster IS the gate
          // here"), so an entry with no email can never be matched however long
          // the student waits - the same dead end an absent github_login is
          // under `enforced`, in a different column.
          const gateField = byLogin ? "github_login" : "email";
          const linked = byLogin
            ? students.filter((s) => typeof s?.github_login === "string" && s.github_login.trim()).length
            : students.filter((s) => normalizeEmail(s?.email)).length;
          const remedy = byLogin
            ? "Add the GitHub usernames column and re-import."
            : "Add the email column and re-import - under claim, the address is what a student proves.";

          if (students.length === 0) {
            addCheck(3, check("roster-check", "tier-3-assignment", label, sev,
              `${ROSTER_PATH} is empty, so nobody can accept this assignment - every attempt is rejected as not-on-roster. Import the roster, or set this assignment to open enrolment.`,
              { students: 0, linked: 0 }, fix));
          } else if (linked === 0) {
            addCheck(3, check("roster-check", "tier-3-assignment", label, sev,
              `${students.length} student(s) are on the roster but none has a ${gateField}, which is the only field acceptance matches on - so nobody can accept. ${remedy}`,
              { students: students.length, linked: 0 }, fix));
          } else if (linked < students.length) {
            addCheck(3, check("roster-check", "tier-3-assignment", label, "warn",
              `${linked} of ${students.length} students on the roster have a ${gateField}. The other ${students.length - linked} cannot accept until theirs is added.`,
              { students: students.length, linked }, fix));
          } else {
            addCheck(3, check("roster-check", "tier-3-assignment", label, "ok",
              `${students.length} student(s) on the roster, all with a ${byLogin ? "GitHub username" : "email address"}.`,
              { students: students.length, linked }));
          }

          // Who is actually bound. Only under `claim`, and only once the roster
          // itself is sound - a binding report over an empty roster is a
          // sentence about nothing.
          //
          // Claims are ORG-SCOPED, so a count of files says nothing about THIS
          // cohort: the join is the address, and it needs the file contents.
          // That is a request per claim, so it is bounded - and a bounded walk
          // may not report `ok`, it says it did not finish (CLAUDE.md).
          if (!byLogin && students.length > 0) {
            const CLAIM_READ_BUDGET = 60;
            const dirRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/students/claims`);
            const files = Array.isArray(dirRes.data)
              ? dirRes.data.filter((f) => f?.type === "file" && typeof f.name === "string" && f.name.endsWith(".json"))
              : [];

            if (dirRes.status === 404 || files.length === 0) {
              // Nobody has claimed yet. Before a cohort starts that is the
              // normal state, so it is only worth saying on a published one.
              addCheck(3, check("claim-bindings", "tier-3-assignment", "Student claims", doc.state === "published" ? "warn" : "info",
                `No student has claimed an address yet, so nobody in this cohort can accept. Students bind themselves the first time they open their invitation link.`,
                { students: students.length, claimed: 0 }));
            } else if (files.length > CLAIM_READ_BUDGET) {
              addCheck(3, check("claim-bindings", "tier-3-assignment", "Student claims", "info",
                `${files.length} claim records in this organization - too many to cross-check here without a request each. Open the Roster tab for the per-student view.`,
                { claims: files.length }));
            } else {
              const records = [];
              let unreadable = 0;
              for (const f of files) {
                const one = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/${f.path}`);
                try {
                  const raw = one.data?.content ? atobSafe(one.data.content) : one.data?.raw;
                  records.push(JSON.parse(raw));
                } catch {
                  unreadable++;
                }
              }

              const summary = claimSummary(parsed, records);
              const orphans = orphanClaims(parsed, records);
              const rows = rosterBindings(parsed, records);
              const conflicted = rows
                .filter((r) => r.binding.state === BINDING_STATES.CONFLICT)
                .map((r) => r.entry?.full_name || r.entry?.email || "(unnamed)");

              if (unreadable > 0) {
                addCheck(3, check("claim-bindings", "tier-3-assignment", "Student claims", "warn",
                  `${unreadable} of ${files.length} claim records could not be read, so this cannot say who is bound. The counts below exclude them.`,
                  { ...summary, unreadable }));
              } else if (conflicted.length > 0) {
                // Bound, but to an account the roster disagrees with. The claim
                // wins at acceptance, so this is not a blocker - it is a wrong
                // answer that will look right until someone checks.
                addCheck(3, check("claim-bindings", "tier-3-assignment", "Student claims", "warn",
                  `${conflicted.length} student(s) are claimed by an account that differs from the github_login on their roster entry (${conflicted.slice(0, 3).join(", ")}${conflicted.length > 3 ? ", ..." : ""}). Unlink the wrong binding from the Roster tab.`,
                  { ...summary, conflicts: conflicted.length },
                  { type: "navigate_roster", label: "Open Roster Editor" }));
              } else if (orphans.length > 0) {
                addCheck(3, check("claim-bindings", "tier-3-assignment", "Student claims", "info",
                  `${summary.bound} of ${summary.students} students are bound. ${orphans.length} claim(s) belong to an address on no roster entry - usually a student removed from the roster, or an address corrected after they claimed.`,
                  { ...summary, orphans: orphans.length }));
              } else if (summary.bound === 0) {
                addCheck(3, check("claim-bindings", "tier-3-assignment", "Student claims", doc.state === "published" ? "warn" : "info",
                  `No student on this roster has claimed yet, so nobody can accept. ${files.length} claim(s) exist in this organization but none matches an address on this roster.`,
                  summary));
              } else {
                addCheck(3, check("claim-bindings", "tier-3-assignment", "Student claims", "ok",
                  `${summary.bound} of ${summary.students} students are bound to a GitHub account` +
                  `${summary.unclaimed ? `; ${summary.unclaimed} have not claimed yet` : ""}` +
                  `${summary.unclaimable ? `; ${summary.unclaimable} have no email and can never claim` : ""}.`,
                  summary));
              }
            }
          }
        }
      }
    }

    // An accepted student who is an ORGANIZATION OWNER cannot be frozen at the
    // deadline. GitHub grants owners admin on every repository in the org, so
    // lockdown's demotion to `pull` is written, verified, and reads back
    // `admin`. The freeze does not hold - and the only thing that said so was
    // the lockdown record, after the deadline had passed. Found by a live
    // finalize rehearsal on 2026-08-26, then found sitting in a real exam
    // cohort four days before its deadline.
    //
    // ONE request for the owners, not one per student: owners are few, so
    // listing them and intersecting beats asking
    // /orgs/{org}/memberships/{login} per acceptor - which on a 200-student
    // cohort is 200 requests nobody asked for, the arithmetic that put the
    // Feedback PR column behind an explicit button.
    if (assignmentId) {
      const accRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/acceptances/${assignmentId}`);
      const acceptors = Array.isArray(accRes.data)
        ? accRes.data
            .filter((f) => typeof f?.name === "string" && f.name.endsWith(".json"))
            .map((f) => f.name.replace(/\.json$/, ""))
        : [];

      // Nobody has accepted: there is no cohort to make a claim about, and a
      // green "all 0 students can be frozen" is a sentence about nothing.
      if (acceptors.length) {
        const PER_PAGE = 100;
        const MAX_PAGES = 5;
        let owners = [];
        let ownersComplete = true;
        for (let page = 1; ; page++) {
          const res = await req("GET", `/orgs/${org}/members?role=admin&per_page=${PER_PAGE}&page=${page}`);
          if (!res.ok || !Array.isArray(res.data)) {
            // Nothing read at all is UNREADABLE (no check). A page that failed
            // after earlier ones succeeded is a truncated read, which may still
            // carry a real match - it just may not report `ok`.
            if (page === 1) owners = null;
            else ownersComplete = false;
            break;
          }
          owners.push(...res.data.map((m) => m?.login).filter(Boolean));
          if (res.data.length < PER_PAGE) break;
          if (page >= MAX_PAGES) { ownersComplete = false; break; }
        }

        const finding = unfreezableAcceptorsFinding({
          acceptors,
          owners,
          ownersComplete,
          org,
          viewerLogin,
        });
        if (finding) {
          addCheck(3, check(
            "cohort-freezable",
            "tier-3-assignment",
            "Cohort Can Be Frozen At The Deadline",
            finding.severity,
            finding.message,
            {
              accepted: acceptors.length,
              unfreezable: finding.unfreezable,
              self: finding.self,
            },
          ));
        }
      }
    }
  }

  return { doc };
}

/**
 * Acceptance broker infrastructure - tier 4.
 *
 * Lifted out of runDiagnostics verbatim. That function ran to 1,345 lines, and
 * nothing about it was hard except finding anything in it - the six tiers were
 * already separated by banner comments and shared almost no state. What they do
 * share is the context bag below plus, between tiers 3 and 5, the assignment
 * document and the broker's name; those are parameters and return values now
 * rather than 400 lines of shared scope.
 */
async function checkBrokerTier({ req, addCheck, org, assignmentId, formDoc, hubOwner, hubRepo, fetchPages, probeProxy }, { doc }) {
  // ---------------------------------------------------------------------------
  // TIER 4: Acceptance Broker Infrastructure
  // ---------------------------------------------------------------------------
  const isPublished = doc?.state === "published";
  const brokerName = doc?.broker_repo || (assignmentId ? `broker-${assignmentId}` : null);

  if (brokerName && isPublished) {
    const brokerRes = await req("GET", `/repos/${org}/${brokerName}`);
    if (brokerRes.status === 404) {
      addCheck(
        4,
        check(
          "broker-repo",
          "tier-4-broker",
          "Student Acceptance Broker Repository (broker-<id>)",
          "fail",
          `Student acceptance broker repository "${org}/${brokerName}" does not exist on GitHub. Click below to create it.`,
          null,
          {
            type: "publish_broker",
            label: "Create Broker Repository Now",
          }
        )
      );
    } else if (!brokerRes.ok) {
      addCheck(
        4,
        check(
          "broker-repo",
          "tier-4-broker",
          "Student Acceptance Broker Repository (broker-<id>)",
          "warn",
          `Could not read broker repo ${brokerName} (HTTP ${brokerRes.status}).`
        )
      );
    } else {
      if (brokerRes.data.private === true) {
        addCheck(
          4,
          check(
            "broker-visibility",
            "tier-4-broker",
            "Acceptance Broker Visibility (Public)",
            "fail",
            `"${brokerName}" is currently private. It must be public so students can star it to accept their assignment.`,
            null,
            {
              type: "make_broker_public",
              brokerName,
              label: "Make Broker Public",
            }
          )
        );
      } else {
        addCheck(
          4,
          check(
            "broker-repo",
            "tier-4-broker",
            "Student Acceptance Broker Repository (broker-<id>)",
            "ok",
            `"${org}/${brokerName}" exists and is public.`
          )
        );
      }

      const wfRes = await req("GET", `/repos/${org}/${brokerName}/contents/.github/workflows/acceptance-trigger.yml`);
      if (wfRes.status === 404) {
        addCheck(
          4,
          check(
            "broker-workflow",
            "tier-4-broker",
            "Automated Student Provisioning Workflow (acceptance-trigger.yml)",
            "fail",
            `acceptance-trigger.yml is missing in ${brokerName}. Starring will not trigger automated repository creation.`,
            null,
            {
              type: "publish_broker",
              label: "Republish Provisioning Workflow",
            }
          )
        );
      } else if (wfRes.ok) {
        const brokerWorkflow = wfRes.data?.content ? atobSafe(wfRes.data.content) : "";
        // A broker published before signed invitations still triggers on a star
        // and never verifies anything. Its link cannot work, but it looks fine.
        if (brokerWorkflow && !brokerWorkflow.includes("verify-invite-token.mjs")) {
          addCheck(
            4,
            check(
              "broker-workflow",
              "tier-4-broker",
              "Automated Student Provisioning Workflow (acceptance-trigger.yml)",
              "fail",
              `${brokerName} is running a pre-invitation workflow that does not verify the signed invitation. Republish the assignment to update it.`,
              null,
              { type: "publish_broker", label: "Republish Provisioning Workflow" }
            )
          );
        } else {
          addCheck(
            4,
            check(
              "broker-workflow",
              "tier-4-broker",
              "Automated Student Provisioning Workflow (acceptance-trigger.yml)",
              "ok",
              "acceptance-trigger.yml verifies the signed invitation before minting any credential."
            )
          );
        }
      }

      // --- Invitation chain ---------------------------------------------
      //
      // Four independent things have to agree before a student can accept, and
      // when any one of them drifts the failure is silent: the broker skips or
      // rejects, nothing is written, and the lecturer sees a working page.
      await runInvitationChecks({ req, addCheck, check, doc, org, brokerName, assignmentId, fromEditor: Boolean(formDoc) });
    }
  } else if (!isPublished) {
    addCheck(
      4,
      check(
        "broker-repo",
        "tier-4-broker",
        "Student Acceptance Broker Repository (broker-<id>)",
        "info",
        `Assignment is in draft mode. Broker repository (${brokerName || "broker-<id>"}) will be created automatically when published.`
      )
    );
  }

  return { isPublished, brokerName };
}

/**
 * Student portal & Pages edge - tier 5.
 *
 * Lifted out of runDiagnostics verbatim. That function ran to 1,345 lines, and
 * nothing about it was hard except finding anything in it - the six tiers were
 * already separated by banner comments and shared almost no state. What they do
 * share is the context bag below plus, between tiers 3 and 5, the assignment
 * document and the broker's name; those are parameters and return values now
 * rather than 400 lines of shared scope.
 */
async function checkPagesTier({ req, addCheck, org, assignmentId, formDoc, hubOwner, hubRepo, fetchPages, probeProxy }, { doc, isPublished, brokerName }) {
  // ---------------------------------------------------------------------------
  // TIER 5: Student Portal & Pages Edge
  // ---------------------------------------------------------------------------
  if (assignmentId && isPublished) {
    // The acceptance card, not the index, is what a student's page fetches. It
    // lives at public/i/<sha256(invite_token)>.json (ARCHITECTURE 4.3.3), so an
    // assignment can be present in the index - which this tier used to treat as
    // success - while the student's link 404s.
    const linkSecret = linkSecretFrom(doc);
    if (linkSecret) {
      const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(linkSecret));
      const cardPath = `public/i/${inviteFileName(digestBytes)}.json`;
      const cardRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/${cardPath}`);
      // UNREADABLE IS NOT EVIDENCE. Only a 404 means the card is absent; a 403,
      // a 500 or a rate limit means we could not look, and reporting "the
      // student's link will not resolve" off one of those tells a lecturer
      // their cohort is broken on the strength of a failed request - and sends
      // them to regenerate a dashboard that was never the problem. Nine other
      // checks in this file already split 404 from the rest; this one did not.
      addCheck(
        5,
        cardRes.ok
          ? check(
              "invitation-card",
              "tier-5-pages",
              "Student Acceptance Card (public/i/<digest>.json)",
              "ok",
              "The invitation link resolves to a compiled acceptance card."
            )
          : cardRes.status === 404
            ? check(
                "invitation-card",
                "tier-5-pages",
                "Student Acceptance Card (public/i/<digest>.json)",
                "fail",
                `No acceptance card was generated for this invitation, so the student's link will not resolve. Regenerate the dashboard to compile it.`,
                null,
                { type: "regen_dashboard", label: "Regenerate Public Dashboard Index" }
              )
            : check(
                "invitation-card",
                "tier-5-pages",
                "Student Acceptance Card (public/i/<digest>.json)",
                "info",
                `Could not read the acceptance card (HTTP ${cardRes.status}), so whether the student's link resolves is unknown. This is not evidence that it is broken.`
              )
      );
    }

    const ctlPublicRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/public/assignments.json`);
    let inControlPublic = false;
    if (ctlPublicRes.ok) {
      try {
        const raw = ctlPublicRes.data?.content ? atobSafe(ctlPublicRes.data.content) : (ctlPublicRes.data?.raw || "{}");
        const json = JSON.parse(raw);
        if (json?.assignments?.[assignmentId]) inControlPublic = true;
      } catch {
        // ignore
      }
    }

    if (inControlPublic) {
      addCheck(
        5,
        check(
          "control-public-data",
          "tier-5-pages",
          "Compiled Assignment Public Index (public/assignments.json)",
          "ok",
          `Assignment "${assignmentId}" is compiled in ${CONTROL_REPO}:public/assignments.json.`
        )
      );
    } else {
      addCheck(
        5,
        check(
          "control-public-data",
          "tier-5-pages",
          "Compiled Assignment Public Index (public/assignments.json)",
          "warn",
          `Assignment is not yet compiled in ${CONTROL_REPO}:public/assignments.json. Run Regenerate Dashboard or Publish.`,
          null,
          {
            type: "regen_dashboard",
            label: "Regenerate Public Dashboard Index",
          }
        )
      );
    }

    if (fetchPages) {
      try {
        const pagesData = await fetchPages(org);
        if (pagesData?.assignments?.[assignmentId]) {
          addCheck(
            5,
            check(
              "pages-live-cdn",
              "tier-5-pages",
              "Student Portal CDN Verification",
              "ok",
              "Live student accept portal is verified on GitHub Pages. Student link is active."
            )
          );
        } else {
          addCheck(
            5,
            check(
              "pages-live-cdn",
              "tier-5-pages",
              "Student Portal CDN Verification",
              "warn",
              "GitHub Pages CDN has not yet received this assignment update. Propagating (~1 to 2 min).",
              null,
              {
                type: "deploy_pages",
                label: "Deploy to GitHub Pages",
              }
            )
          );
        }
      } catch {
        addCheck(
          5,
          check(
            "pages-live-cdn",
            "tier-5-pages",
            "Student Portal CDN Verification",
            "warn",
            "Could not query live GitHub Pages endpoint."
          )
        );
      }
    }
  }
}


function finishDiagnostics(org, assignmentId, tiers, allChecks) {
  const overall = allChecks.reduce((acc, c) => worse(acc, c.severity), "ok");
  return {
    schema_version: 1,
    org,
    assignment_id: assignmentId,
    generated_at: new Date().toISOString(),
    overall,
    tiers,
    checks: allChecks,
  };
}
