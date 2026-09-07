// An e2e spec that reaches the public internet is not a test of this code.
//
// `tests/e2e/07-multiuser-concurrent.spec.mjs` proxied two of its routes to
// GitHub Pages and fell back to a fixture only if the fetch failed - left over
// from before the acceptance card moved behind the token digest. Two things
// came of it, and the second is the one that matters:
//
//   * A DNS lookup, a TLS handshake and a round trip sat inside the route
//     handler that renders `.team-item-card`, with a 5s expect timeout waiting
//     behind it. Green alone, red under full-suite load, green again on a
//     re-run - the signature that gets read as "concurrency is hard" and
//     retried away. It cost a red suite on 2026-09-07.
//   * The live URL for the assignment list answers 200, so a hermetic spec was
//     asserting against whatever is deployed at that moment. Nobody publishing
//     to that org would connect their change to this test going red.
//
// The teams URL answered 404 by then, so that leg had been pure latency for
// however long the path had been wrong: a proxy that could no longer proxy,
// costing a round trip per request and changing nothing.
//
// `tests/multiuser-live.spec.mjs` is the deliberate live variant - real tokens
// from a gitignored .env.test, skipped without them. It lives outside
// `tests/e2e/`, which is what makes this sweep expressible as a directory rule
// rather than a list of exceptions someone has to keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = fileURLToPath(new URL('./e2e/', import.meta.url));
const specs = readdirSync(E2E).filter((f) => f.endsWith('.spec.mjs'));

/** Source with line comments stripped, so a URL in prose is not a finding. */
const code = (f) =>
  readFileSync(join(E2E, f), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

test('the e2e specs exist and are being swept', () => {
  // A rename of the directory must not turn this file into a vacuous pass -
  // an empty list satisfies every assertion below.
  assert.ok(specs.length > 50, `expected the e2e suite, found ${specs.length} specs`);
});

test('no e2e spec fetches from the network', () => {
  // `fetch(` inside a spec runs in the TEST process, not the page, so it is
  // never intercepted by page.route and never subject to a Playwright timeout.
  // Whatever it waits for is added to every assertion behind it.
  const offenders = specs.filter((f) => /\bfetch\s*\(\s*[`'"]?https?:/i.test(code(f)));
  assert.deepEqual(
    offenders,
    [],
    'a spec under tests/e2e/ must serve its own fixtures; the live variant is tests/multiuser-live.spec.mjs',
  );
});

test('no e2e route handler falls back to a fixture after trying the network', () => {
  // The shape, not just the call: `try { const r = await fetch(live) ... }
  // catch {}` followed by a fulfil is a route that LOOKS mocked. Every
  // reviewer reads the fixture and none of them reads the round trip in front
  // of it.
  const offenders = specs.filter((f) => /try\s*\{[\s\S]{0,400}?\bfetch\s*\(\s*[`'"]?https?:/i.test(code(f)));
  assert.deepEqual(offenders, [], 'a fixture behind a live fetch is a fixture nobody can see is not being used');
});

test('an absolute deployed URL is not hard-coded into a spec', () => {
  // The published site's own origin. A spec naming it is either fetching it
  // (above) or asserting on it, and both make the deployment a test input.
  const offenders = specs.filter((f) => /pxl-digital-application-samples\.github\.io/i.test(code(f)));
  assert.deepEqual(offenders, [], 'point at the local dev server, or serve the bytes yourself');
});
