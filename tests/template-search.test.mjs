// The template picker's search query.
//
// `listOrgTemplates` searched `org:<org> is:template fork:true`. `is:template`
// is not a qualifier GitHub has, and search ignores an unknown `is:` value in
// silence - so the query asked for every repository in the org. Measured on
// PXL-Automation-II, 2026-09-07: `org:X` -> 93 results, `org:X is:template` ->
// the same 93, `org:X template:true` -> 11.
//
// The client-side `.filter(r => r.is_template)` is what hid it for a year. With
// `fork:true` the unfiltered search matched 256 repositories, `per_page=100`
// kept the first hundred, and the filter salvaged whichever templates were
// among them - 5 of that org's 11. So the picker was exactly right on every org
// under 100 repositories and silently lost templates on every org above it, in
// no order anyone can predict: a private template created minutes earlier
// during a demo was not in the first 100, and the lecturer was told it did not
// exist.
//
// A wrong qualifier cannot be caught by reading the response. It is a SUPERSET
// of the right answer, trimmed by the filter into something plausible - no
// error, no empty state, and the fallback leg never runs because the search
// succeeded. The only thing that can go wrong here is the query string, so the
// query string is what this asserts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = readFileSync(
  fileURLToPath(new URL("../frontend/src/lib/api.js", import.meta.url)),
  "utf8",
);

/** The body of listOrgTemplates, comments stripped, so only real code counts. */
function templateSearchBody() {
  const start = API.indexOf("export async function listOrgTemplates");
  assert.notEqual(start, -1, "listOrgTemplates must still exist under that name");
  const end = API.indexOf("\nexport ", start + 1);
  const body = API.slice(start, end === -1 ? API.length : end);
  return body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The search query it builds, as written. */
function query() {
  const body = templateSearchBody();
  const m = body.match(/encodeURIComponent\(`([^`]*)`\)/);
  assert.ok(m, "listOrgTemplates must build its query with a template literal");
  return m[1];
}

test("the template search filters on template:true", () => {
  assert.match(
    query(),
    /\btemplate:true\b/,
    "without it GitHub returns every repository in the org",
  );
});

test("it does not use is:template, which GitHub ignores in silence", () => {
  // The failure this file exists for. `is:` takes a fixed vocabulary
  // (public, private, fork, archived, mirror, sponsorable...) and `template`
  // is not in it. An unknown value is dropped rather than refused, so the
  // query stays a 200 and the mistake never surfaces as one.
  assert.doesNotMatch(query(), /\bis:template\b/);
});

test("it still asks for forks as well as non-forks", () => {
  // The 2026-08-24 fix, and it is one qualifier away from the one above:
  // search hides forks by default, and a forked template is a template.
  // PXL-2TIN-NetAdv-26-27/Guts-DotNetAdvanced-2627 was invisible for that.
  assert.match(query(), /\bfork:true\b/);
  assert.doesNotMatch(query(), /\bfork:only\b/, "that swaps the blind spot for its opposite");
});

test("it scopes the search to the org it was asked about", () => {
  assert.match(query(), /\borg:\$\{org\}/);
});

test("the search is walked, not read once", () => {
  // "Found N template repositories" and the wall that says there are none are
  // both statements about the WHOLE collection, and both were being made from
  // a single per_page=100 read. What each page contains is e2e's job (spec
  // 70); this only refuses the shape that cannot be right.
  const body = templateSearchBody();
  assert.match(body, /pagedGet\(/, "one walker, shared with every other list read here");
  assert.doesNotMatch(
    body,
    /ghApi\([^)]*\/search\/repositories/,
    "a bare one-page read of a list endpoint",
  );
});

test("a walk that could not finish is not reported as the list", () => {
  // Both halves. `truncated` is the walker's own signal; `total_count` is the
  // second source, because GitHub omits the Link header on a single-page
  // response - so "there was no page two" and "we were not told about page
  // two" are the same bytes, and only the count separates them.
  const body = templateSearchBody();
  assert.match(body, /truncated/);
  assert.match(body, /total_count/);
});

test("the client-side is_template filter stays, and is not the filter", () => {
  // Belt and braces, in that order: the query does the filtering and this
  // catches anything the API hands back that is not a template. It is only
  // safe while the query is narrow - as a REPLACEMENT for the qualifier it is
  // the bug, because it runs after per_page has already thrown results away.
  assert.match(templateSearchBody(), /\.filter\(\s*\(r\)\s*=>\s*r\.is_template\s*\)/);
});
