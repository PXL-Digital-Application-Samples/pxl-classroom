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
