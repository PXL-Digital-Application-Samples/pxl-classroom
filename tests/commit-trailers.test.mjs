// A `Co-Authored-By` trailer is an identity claim, and GitHub resolves it by
// EMAIL.
//
// Whoever has that address verified on their account is credited as a
// contributor to this repository - in the sidebar, in the hovercard, in the
// contributor graph. It does not matter what name the trailer writes beside it.
//
// Seven commits on 2026-08-19 say:
//
//     Co-Authored-By: Antigravity <antigravity@google.com>
//
// `antigravity@google.com` is verified on the account of a stranger in New York
// with no connection to this project, so GitHub has credited him as a
// contributor to a public repository ever since. He has never had access and
// never pushed anything; the attribution is cosmetic and it is still wrong.
// Removing it means rewriting 400 commits and force-pushing a protected branch
// to take one avatar off a sidebar, which is not worth it - so the history
// stands and this stops it happening again.
//
// The REST contributors endpoint does not show this: it counts commit AUTHORS,
// and answered `tomcoolpxl` and `Copilot` while the sidebar showed six faces.
// GraphQL's `Commit.authors` is what resolves a co-author to an account.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Everything up to here predates the rule and is left alone.
 *
 * Grandfathered rather than fixed, deliberately: the trailers below this point
 * include `antigravity@deepmind.com`, `noreply@google.com` and three
 * `@example.com` addresses, and correcting them would rewrite the history of a
 * public repository for an attribution nobody can act on.
 */
const BASELINE = "0b06dbb";

/**
 * Addresses a co-author trailer may use.
 *
 * The test is "can this address ever mean somebody other than the tool it
 * names". `@users.noreply.github.com` cannot: GitHub issues it per account and
 * nobody else can hold it. A vendor's published noreply address cannot either,
 * and is listed here one at a time rather than by domain - `@google.com` is a
 * domain, `antigravity@google.com` is a person's mailbox, and that distinction
 * is the whole bug.
 */
const ALLOWED_EMAILS = new Set([
  "noreply@anthropic.com",
  "noreply@openai.com",
]);

const ALLOWED_SUFFIX = "@users.noreply.github.com";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/**
 * `[{ sha, subject, name, email }]` for every co-author trailer since BASELINE.
 *
 * GIT PARSES THE TRAILERS, not a regex over the message body. The first version
 * matched `co-authored-by:` anywhere in the body, and failed immediately on its
 * own commit: that message QUOTES the offending trailer, indented, in order to
 * explain it. A trailer is the unindented block at the END of a message, and
 * `%(trailers:...)` is the only thing that knows the difference. Never
 * re-implement the thing under test.
 */
function coAuthorsSinceBaseline() {
  const SEP = "";
  const raw = git([
    "log",
    `${BASELINE}..HEAD`,
    `--format=${SEP}%H%n%s%n%(trailers:key=Co-authored-by,valueonly,unfold)`,
  ]);
  const out = [];
  for (const block of raw.split(SEP).slice(1)) {
    const [sha, subject, ...values] = block.split("\n");
    for (const value of values) {
      const m = value.match(/^\s*(.+?)\s*<([^>]+)>\s*$/);
      if (m) out.push({ sha: sha.slice(0, 8), subject, name: m[1], email: m[2].toLowerCase() });
    }
  }
  return out;
}

test("a co-author trailer names an address that can only be the tool it claims", () => {
  // A guard that cannot see the history must SAY so rather than pass. A shallow
  // clone is the ordinary CI checkout, so ci.yml gives this job `fetch-depth: 0`
  // - if that is ever removed, this fails here instead of quietly checking
  // nothing.
  try {
    git(["cat-file", "-e", `${BASELINE}^{commit}`]);
  } catch {
    assert.fail(
      `${BASELINE} is not in this clone, so the trailers since it cannot be checked. ` +
        "A shallow checkout will do this: the CI job needs fetch-depth: 0. " +
        "If the history was rewritten, move BASELINE to the new commit.",
    );
  }

  const offenders = coAuthorsSinceBaseline().filter(
    (c) => !ALLOWED_EMAILS.has(c.email) && !c.email.endsWith(ALLOWED_SUFFIX),
  );

  assert.deepEqual(
    offenders.map((c) => `${c.sha} ${c.name} <${c.email}> - ${c.subject}`),
    [],
    "GitHub credits whoever holds that address as a contributor to this repository. " +
      "`antigravity@google.com` belongs to a stranger and has credited him on seven commits " +
      "since 2026-08-19. Use the tool's published noreply address, or its " +
      "@users.noreply.github.com one, or no trailer at all.",
  );
});

test("the allowlist holds addresses, never domains", () => {
  // `@google.com` would have permitted the exact trailer this exists to stop.
  // An entry has to be a whole mailbox, and the one wildcard is GitHub's own
  // per-account domain, which cannot be shared.
  for (const email of ALLOWED_EMAILS) {
    assert.match(email, /^[^@\s]+@[^@\s]+\.[a-z]+$/i, `${email} is not a single address`);
    assert.ok(!email.startsWith("@"), `${email} is a domain, not an address`);
  }
  assert.equal(ALLOWED_SUFFIX, "@users.noreply.github.com");
});
