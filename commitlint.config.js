// PXL Classroom - what a commit subject has to look like, and why the list of
// types is not written here.
//
// The version and the release notes are DERIVED from these subjects
// (`.releaserc.json`, `.github/workflows/release.yml`), so a malformed one is
// not a style slip: `fixed: …` instead of `fix: …` releases nothing, appears in
// no release notes, and says so nowhere. There is no pull request on this
// repository to catch it either - CLAUDE.md is commit-and-push to `main` - so
// the `commit-msg` hook is the only place it can be caught at all.
//
// THE TYPES COME OUT OF `.releaserc.json`. Spelling them again here is the
// defect this codebase keeps paying for: two lists that must agree, with
// nothing deriving one from the other. A type the hook accepts and the release
// config does not know is a commit that vanishes from the notes - which is the
// silent half, and the worse one.
//
// @commitlint/config-conventional supplies everything else (subject present,
// no trailing full stop, header length), so nothing about the Conventional
// Commits grammar is re-implemented here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every type `.releaserc.json` has an opinion about - whether that opinion is
 * "release a patch", "release nothing" or "keep it out of the notes".
 *
 * Both halves are read, because they answer different questions and a type
 * declared in only one of them is still a type the project has decided about:
 *   releaseRules            - does this type move the version?
 *   presetConfig.types      - does this type appear in the release notes?
 */
export function declaredTypes(releaserc) {
  const plugins = Array.isArray(releaserc?.plugins) ? releaserc.plugins : [];
  const config = (name) => {
    const entry = plugins.find((p) => Array.isArray(p) && p[0] === name);
    return entry?.[1] ?? {};
  };

  const fromRules = (config("@semantic-release/commit-analyzer").releaseRules ?? [])
    .map((r) => r.type)
    .filter(Boolean);
  const fromNotes = (config("@semantic-release/release-notes-generator").presetConfig?.types ?? [])
    .map((t) => t.type)
    .filter(Boolean);

  // `feat` and `fix` are the two the Conventional Commits spec REQUIRES, and
  // the conventionalcommits preset handles them without either list naming
  // them. They are always allowed, whatever the config says.
  return [...new Set(["feat", "fix", ...fromRules, ...fromNotes])].sort();
}

const releaserc = JSON.parse(readFileSync(join(here, ".releaserc.json"), "utf8"));

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", declaredTypes(releaserc)],
    // The body carries the reasoning on this project and is regularly long -
    // and a `Co-Authored-By` trailer or a URL cannot be wrapped without
    // changing what it means.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
