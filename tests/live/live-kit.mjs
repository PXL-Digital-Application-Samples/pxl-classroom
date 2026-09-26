// PXL Classroom - what the live scripts share. Not part of `npm test`.
//
// smoke.mjs and drill.mjs drive the REAL deployment with the real accounts in
// .env.test. Both need the same accounts, the same preflight and the same
// acceptance a student performs, and a second copy of any of those is a copy
// that drifts - so they live here and nowhere else.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signAcceptanceTitle } from "../../lib/acceptance-signature.mjs";
import { GITHUB_API_VERSION } from "../../lib/github-api-version.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function die(m) { console.error(`\n${m}\n`); process.exit(2); }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");

// --- env ---------------------------------------------------------------------

export function loadEnv() {
  // LIVE_ENV_FILE points a worktree at the main checkout's .env.test, rather
  // than copying a file full of tokens into every worktree.
  const path = process.env.LIVE_ENV_FILE || join(root, ".env.test");
  if (!existsSync(path)) die(`.env.test not found at ${path}`);
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  // A real environment variable WINS over the file, so a run can be pointed at
  // a different org without editing credentials:
  //
  //   TEST_ORG=… TEST_ASSIGNMENT_ID=… node tests/live/smoke.mjs
  //
  // .env.test's own TEST_ORG went stale once already - the accounts were
  // removed from the org it names - and editing a file full of tokens to
  // retarget a test run is the wrong shape.
  for (const key of Object.keys(env)) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// --- output ------------------------------------------------------------------

export function reporter() {
  let failures = 0;
  return {
    ok: (m) => console.log(`  ok    ${m}`),
    bad: (m) => { failures++; console.log(`  FAIL  ${m}`); },
    note: (m) => console.log(`        ${m}`),
    failures: () => failures,
  };
}

// --- api ---------------------------------------------------------------------

export async function api(path, { token, method = "GET", body } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "pxl-classroom-live",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { status: res.status, ok: res.ok, data };
}

// --- accounts ----------------------------------------------------------------
//
// THREE ACCOUNTS, NOT FOUR. tomcoolpxl-student2 is flagged by GitHub: its own
// token authenticates, but `GET /users/tomcoolpxl-student2` is 404 to everyone
// else, so it cannot be added as a collaborator and cannot be provisioned for.
// lecturer2 stands in as the second student instead - a role here is org
// membership plus a roster line, nothing intrinsic to the account.
//
// LECTURER is the lecturer. STUDENT_A is the student. STUDENT_B is lecturer2
// doing duty as the second student, which is what makes the group scenarios
// possible with three accounts.
export function accounts(env) {
  return {
    LECTURER: { login: env.TEST_LECTURER_LOGIN, token: env.TEST_LECTURER_TOKEN, email: env.TEST_LECTURER_EMAIL },
    STUDENT_A: { login: env.TEST_STUDENT1_LOGIN, token: env.TEST_STUDENT1_TOKEN, email: env.TEST_STUDENT1_EMAIL },
    STUDENT_B: { login: env.TEST_LECTURER2_LOGIN, token: env.TEST_LECTURER2_TOKEN, email: env.TEST_LECTURER2_EMAIL },
  };
}

/** Can these accounts do anything at all? Fills in each account's numeric id. */
export async function checkAccounts(ACCOUNTS, r) {
  for (const [role, a] of Object.entries(ACCOUNTS)) {
    if (!a.token) { r.bad(`${role}: no token in .env.test`); continue; }
    const me = await api("/user", { token: a.token });
    if (!me.ok) { r.bad(`${role} (${a.login}): token rejected, HTTP ${me.status}`); continue; }
    a.id = me.data.id;

    // Visible to OTHERS, not just to itself. A flagged account authenticates
    // fine and is 404 to everyone else - which is what makes it unusable as a
    // collaborator, and what made this check necessary.
    const seen = await fetch(`https://api.github.com/users/${a.login}`);
    if (!seen.ok) {
      r.bad(`${role} (${a.login}): authenticates, but GET /users/${a.login} is ${seen.status} to anonymous - the account is flagged and cannot be provisioned for`);
      continue;
    }
    r.ok(`${role}: ${a.login} #${a.id}, visible publicly`);
  }
}

// ONE TRAP, and it is the reason this says so out loud: if the second student
// is an ORG MEMBER and the org's `default_repository_permission` is anything
// above `none`, they already have access to every repository in the org. A
// broken collaborator grant would then be invisible and a live run would pass
// over it - and a demotion would look like it worked. See lib/audit.mjs's
// baseRepositoryPermissionFinding.
export async function checkOrg(org, lecturer, r) {
  const ctl = await api(`/repos/${org}/pxl-classroom-control`, { token: lecturer.token });
  if (!ctl.ok) r.bad(`lecturer cannot read ${org}/pxl-classroom-control (HTTP ${ctl.status}) - add the account to the org`);
  else r.ok(`lecturer can read ${org}/pxl-classroom-control`);

  const res = await api(`/orgs/${org}`, { token: lecturer.token });
  const base = res.data?.default_repository_permission;
  if (base === undefined || base === null) {
    r.note(`could not read ${org}'s default_repository_permission (needs org admin) - verify it is "none" by hand`);
  } else if (base !== "none") {
    r.bad(`${org} default_repository_permission is "${base}", not "none": an org MEMBER already has repository access, so a failed collaborator grant would be invisible`);
  } else {
    r.ok(`${org} default_repository_permission is "none" - a collaborator grant is the only way in, so provisioning is actually being tested`);
  }
  // `plan` is only returned to an owner, and null is "could not read", never "free".
  return { plan: res.data?.plan?.name ?? null };
}

// --- acceptance --------------------------------------------------------------

/**
 * Sign an acceptance title the way the SPA does, without submitting it.
 *
 * The same four arguments frontend/src/lib/invite.js passes. `kid` is the
 * format tag ("a1"), `subject` is the assignment id (hashed to 8 bytes inside),
 * and the nonce is 4 random bytes as hex - it is per-acceptance, not the
 * assignment's invite_nonce.
 */
export async function signAcceptance({ secret, assignmentId, student }, r) {
  if (!secret) { r.bad("no secret to sign with"); return null; }
  try {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
    const title = await signAcceptanceTitle({
      privateKey: secret,
      kid: "a1",
      subject: assignmentId,
      githubId: student.id,
      nonce,
    });
    r.ok(`signed title: ${title.slice(0, 48)}…  (${title.length} chars)`);
    // The broker refuses a title over MAX_TITLE_LENGTH, so a signature that
    // cannot fit is a failure worth catching here rather than on a student's
    // screen.
    if (title.length > 256) r.bad(`title is ${title.length} chars - the broker's limit is 256`);
    return title;
  } catch (err) {
    r.bad(`could not sign: ${err.message}`);
    return null;
  }
}

/**
 * Open the acceptance issue on the broker, exactly as a student's browser does.
 * Resolves the issue number, or null when it could not be opened.
 */
export async function openAcceptanceIssue({ org, broker, title, student, teamSlug = null, teamName = null }, r) {
  // The team hint is appended AFTER signing - it is a concurrency key, never an
  // authoritative value, and the hub re-derives the real team from the body.
  // read-team-payload.mjs refuses a body that names a different team from the
  // title, so these two must agree.
  const fullTitle = teamSlug ? `${title} team:${teamSlug}` : title;
  if (fullTitle.length > 256) { r.bad(`title with the team hint is ${fullTitle.length} chars, over GitHub's 256`); return null; }

  const res = await api(`/repos/${org}/${broker}/issues`, {
    token: student.token,
    method: "POST",
    body: {
      title: fullTitle,
      // TOP-LEVEL fields, exactly what buildAcceptanceBody writes. Nesting them
      // under `team` produced `rejected:no-team` - parseTeamPayload reads
      // parsed.team_slug and nothing else, so a well-formed but differently
      // shaped body is indistinguishable from no team at all. `join` is one of
      // the three actions it honours (join | create | switch); anything else is
      // dropped to "".
      body: teamSlug
        ? JSON.stringify({ team_slug: teamSlug, team_name: teamName ?? teamSlug, team_action: "join" })
        : "",
    },
  });
  if (!res.ok) { r.bad(`could not open the broker issue: HTTP ${res.status} ${res.data?.message ?? ""}`); return null; }
  r.ok(`opened ${org}/${broker}#${res.data.number}`);
  return res.data.number;
}

/**
 * Do what a student does next: accept the repository invitation. Until they
 * do, they have no access at all, so this is part of the flow rather than a
 * detail.
 */
export async function acceptInvitation({ student, repoName }, r) {
  const invites = await api("/user/repository_invitations", { token: student.token });
  const mine = (invites.data || []).find((v) => v.repository?.name === repoName);
  if (!mine) { r.note(`${student.login}: no pending invitation (already a collaborator?)`); return; }
  const accepted = await api(`/user/repository_invitations/${mine.id}`, { token: student.token, method: "PATCH" });
  if (accepted.status === 204) r.ok(`${student.login} accepted the repository invitation`);
  else r.bad(`${student.login} could not accept the invitation: HTTP ${accepted.status}`);
}
