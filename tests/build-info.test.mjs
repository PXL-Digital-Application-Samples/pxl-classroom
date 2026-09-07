// What the header says about the running build.
//
// Nothing identified the deployed build before this. Answering "which version
// were you on" meant listing deploy-frontend runs, reading headSha off each and
// matching deploy times against a commit - three API calls, possible only for
// somebody with the repository open, and impossible for the lecturer reporting
// the problem.
//
// build-info.js reads `import.meta.env`, which node:test cannot provide, so the
// LABEL RULE is tested here as a pure function and the module is checked for
// the shape that keeps it honest. The rule is the part with judgement in it;
// reading two environment variables is not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "frontend", "src", "lib", "build-info.js"), "utf8");

/** The rule as build-info.js implements it, restated so it can be run. */
function label(version, sha) {
  const short = sha ? sha.slice(0, 7) : "";
  return [version || (sha ? "" : "dev"), short ? `(${short})` : ""].filter(Boolean).join(" ");
}

test("a real build shows both, because each answers a different question", () => {
  // The version is what you say out loud; the SHA is what settles it.
  assert.equal(label("v1.4.0", "9fb7639abc1234"), "v1.4.0 (9fb7639)");
});

test("no tag yet still identifies the build", () => {
  // Before the first release there is no version, and the SHA alone is enough
  // to find the code. Inventing "1.0.0" here would be a number that means
  // nothing and looks like it means something.
  assert.equal(label("", "9fb7639abc1234"), "(9fb7639)");
});

test("a local build says dev rather than guessing", () => {
  assert.equal(label("", ""), "dev");
});

test("the short SHA is seven characters - what a human compares and git accepts", () => {
  assert.equal(label("v1.0.0", "abcdef1234567890").split("(")[1], "abcdef1)");
});

test("the commit URL is built from deployment.yml, never re-spelled", () => {
  // A hard-coded owner/repo here would be a second spelling of a value the
  // deployment already owns, and would point a fork's users at this repository.
  assert.match(SRC, /import\s*\{\s*HUB_REPO\s*\}\s*from\s*'\.\/deployment\.js'/);
  assert.equal(/github\.com\/PXL-/i.test(SRC), false, "hard-coded owner in build-info.js");
});

test("no commit URL when there is no commit to point at", () => {
  // A link to `/commit/` with an empty SHA is a 404 somebody finds by clicking.
  assert.match(SRC, /BUILD_COMMIT_URL\s*=\s*rawSha\s*\?/);
});

test("no release URL before the first release, for the same reason", () => {
  // `/releases/tag/` with an empty version is the same 404 one line down.
  assert.match(SRC, /BUILD_RELEASE_URL\s*=\s*rawVersion\s*\?/);
});

test("the header links to the RELEASE when there is one, the commit when not", () => {
  // "What changed" is answered by release notes; a commit page answers it only
  // for somebody who can read a diff. The SHA is still in the label either way,
  // because that is what settles WHICH build is on screen - so nothing is lost
  // by pointing the link at the more useful of the two.
  assert.match(SRC, /BUILD_LINK_URL\s*=\s*BUILD_RELEASE_URL\s*\|\|\s*BUILD_COMMIT_URL/);

  // And the header uses that one, not either half directly - a header bound to
  // BUILD_COMMIT_URL would keep working and quietly never link a release.
  const header = readFileSync(join(ROOT, "frontend", "src", "components", "AppHeader.vue"), "utf8");
  assert.match(header, /:href="BUILD_LINK_URL"/);
  assert.match(header, /v-if="BUILD_LINK_URL"/);
});

test("the release URL is the tag verbatim, never rebuilt from parts", () => {
  // `git describe` returns the tag as written (`v1.0.0`), and .releaserc.json's
  // tagFormat makes that also the release's own name. Stripping a `v` or
  // re-adding one is how a link 404s on a tag somebody spelled differently.
  assert.match(SRC, /releases\/tag\/\$\{rawVersion\}/);
});

test("the deploy injects exactly what the module reads", () => {
  // Two files, one contract. The build passing VITE_BUILD_SHA while the module
  // read VITE_COMMIT_SHA would render `dev` in production for ever, and look
  // like a local build to whoever reported it.
  const wf = readFileSync(join(ROOT, ".github", "workflows", "deploy-frontend.yml"), "utf8");
  for (const key of ["VITE_BUILD_SHA", "VITE_BUILD_VERSION"]) {
    assert.ok(SRC.includes(key), `build-info.js does not read ${key}`);
    assert.ok(wf.includes(key), `deploy-frontend.yml does not inject ${key}`);
  }
  // And the tags it needs to resolve a version at all.
  assert.match(wf, /fetch-tags:\s*true/, "deploy checkout does not fetch tags, so the version is always empty");
});
