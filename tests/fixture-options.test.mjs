// A fixture option nobody destructures is discarded in silence.
//
// `tests/e2e/16-team-lifecycle-edge-cases.spec.mjs` passed an `acceptances`
// option to `setupStandardMockRoutes` for months. The fixture never named it,
// so JavaScript threw it away without a word: no error, no warning, and a
// green test that looked like it was exercising a mock that did not exist.
// Replacing the whole payload with garbage left the test passing, which is the
// only way to find out - and the option could never have worked, because the
// scenario renders the STUDENT surface and a student cannot read the control
// repo at all. It was deleted in eff272d.
//
// This is the guard so the next one cannot ride along the same way. It scans
// three shapes, because the discard happens at each of them:
//
//   1. A key passed straight to `setupStandardMockRoutes` that the fixture's
//      parameter list does not name.
//   2. A key passed to a spec-local wrapper that forwards its options into the
//      fixture (`...opts` / `...extra`, or a bare pass-through). Seventeen of
//      them exist, so checking only shape 1 leaves a large part of the surface
//      unchecked. Forwarding is followed TRANSITIVELY - spec 32's
//      `openNewAssignmentForm` hands its options to `openAdmin`, which is the
//      one that spreads; three of the seventeen are only reachable that way.
//   3. The general form: any helper whose parameter is a destructuring pattern
//      reads exactly the keys it names, so a caller passing an unnamed key
//      with no rest element to catch it is handing over data nothing reads.
//
// And the inverse, on the fixture's own side: an option it declares but never
// reads in its body is the same lie told from the other end.
//
// The scanner is a brace-depth walk over sources with comments, strings and
// template literals blanked out - no parser dependency, in a repo whose test
// runner is bare `node --test`. Its own blind spot is worth naming: it proves
// a key REACHES the code that reads it, not that the route it feeds is
// exercised by the spec passing it. Only a per-test mutation run shows that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = join(ROOT, 'tests/e2e');
const FIXTURE_PATH = join(ROOT, 'tests/fixtures/e2e-fixtures.mjs');

/** The fixture entry point every spec routes its mocks through. */
const ENTRY = 'setupStandardMockRoutes';
/** Its options object is the second argument. */
const ENTRY_ARG = 1;

// ---------------------------------------------------------------------------
// A source walker that only has to survive this repo's own test sources.
// ---------------------------------------------------------------------------

/**
 * Blank out comments and string/template contents, preserving length and line
 * breaks so every index still maps back onto the original source.
 *
 * `${...}` insides are LEFT INTACT: a computed key like `{ [id]: assignment }`
 * is written inside template literals all over these specs, and blanking them
 * would unbalance the brace depth the rest of the walk depends on.
 */
function blank(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out[i] = ' '; i++; }
        if (i < n && src[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (depth === 0 && src[i] === '`') { i++; break; }
        if (depth === 0 && src[i] === '$' && src[i + 1] === '{') { depth = 1; i += 2; continue; }
        if (depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) { i++; continue; } }
          i++;
          continue;
        }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open`, or -1. */
function matchPair(b, open) {
  let depth = 0;
  for (let i = open; i < b.length; i++) {
    const c = b[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Spans of the top-level comma-separated items between `open` and `close`. */
function splitTopLevel(b, open, close) {
  const parts = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = b[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push([start, i]); start = i + 1; }
  }
  parts.push([start, close]);
  return parts;
}

/**
 * Top-level keys of the object literal or destructuring pattern at `open`.
 * A spread or a computed key is reported as such rather than by name - neither
 * can be checked statically, and pretending otherwise would be a false alarm.
 */
function topLevelKeys(b, open) {
  const close = matchPair(b, open);
  const keys = [];
  let depth = 0;
  let atKey = true;
  for (let i = open; i < close; i++) {
    const c = b[i];
    if (c === '{' || c === '(' || c === '[') {
      if (depth === 1 && c === '[' && atKey) { keys.push({ name: '<computed>', index: i }); atKey = false; }
      depth++;
      if (depth === 1) atKey = true;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') { depth--; continue; }
    if (depth !== 1) continue;
    if (c === ',') { atKey = true; continue; }
    if (/\s/.test(c)) continue;
    if (!atKey) continue;
    const m = b.slice(i).match(/^(\.\.\.|[A-Za-z_$][\w$]*)/);
    if (m) {
      keys.push({ name: m[1] === '...' ? '<spread>' : m[1], index: i });
      i += m[1].length - 1;
    }
    atKey = false;
  }
  return keys;
}

const namedKeys = (b, open) =>
  topLevelKeys(b, open).map((k) => k.name).filter((n) => !n.startsWith('<'));

const hasRest = (b, open) => topLevelKeys(b, open).some((k) => k.name === '<spread>');

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Named function declarations and named arrow functions, with their `(`. */
function declarations(b) {
  const found = [];
  let m;
  const fnRe = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnRe.exec(b))) {
    found.push({ name: m[1], parenOpen: m.index + m[0].length - 1 });
  }
  const arrowRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = arrowRe.exec(b))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchPair(b, parenOpen);
    if (parenClose < 0) continue;
    if (!/^\s*=>/.test(b.slice(parenClose + 1))) continue;
    found.push({ name: m[1], parenOpen });
  }
  return found;
}

/** Every call site of `name`, as the span of its argument list. */
function callSites(b, name) {
  const sites = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(b))) {
    const before = b.slice(Math.max(0, m.index - 24), m.index);
    // The declaration itself, and `something.name(...)` on another object.
    if (/(function|const|let|var)\s+$/.test(before)) continue;
    if (/\.\s*$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchPair(b, open);
    if (close < 0) continue;
    sites.push({ open, close, args: splitTopLevel(b, open, close) });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// The three scans.
// ---------------------------------------------------------------------------

/** What `setupStandardMockRoutes` names in its parameter list, and reads. */
export function parseFixtureOptions(fixtureSrc) {
  const b = blank(fixtureSrc);
  const sig = b.indexOf(`export async function ${ENTRY}(`);
  assert.ok(sig >= 0, `${ENTRY} not found in the fixture`);
  const paramOpen = b.indexOf('{', sig);
  const declared = namedKeys(b, paramOpen);

  const paramClose = matchPair(b, paramOpen);
  const bodyOpen = b.indexOf('{', b.indexOf(')', paramClose));
  const body = fixtureSrc.slice(bodyOpen, matchPair(b, bodyOpen));
  const unread = declared.filter((name) => !new RegExp(`\\b${name}\\b`).test(body));

  return { declared, unread };
}

/**
 * Resolve, to a fixed point, every local function that hands its own options
 * on to the fixture - directly, or through another such function.
 *
 * Returns name -> { argIndex, allowedKeys }, where `allowedKeys` is the
 * fixture's options plus anything the wrapper consumes itself.
 */
function resolveForwarders(b, fixtureOptions) {
  const targets = new Map([
    [ENTRY, { argIndex: ENTRY_ARG, allowedKeys: new Set(fixtureOptions) }],
  ]);

  let grew = true;
  while (grew) {
    grew = false;
    for (const decl of declarations(b)) {
      if (targets.has(decl.name)) continue;
      const parenClose = matchPair(b, decl.parenOpen);
      if (parenClose < 0) continue;
      const bodyOpen = b.indexOf('{', parenClose);
      const bodyClose = matchPair(b, bodyOpen);
      if (bodyOpen < 0 || bodyClose < 0) continue;
      const params = splitTopLevel(b, decl.parenOpen, parenClose);

      for (const [targetName, target] of targets) {
        for (const site of callSites(b, targetName)) {
          if (site.open < bodyOpen || site.close > bodyClose) continue;
          const arg = site.args[target.argIndex];
          if (!arg) continue;
          const text = b.slice(arg[0], arg[1]).trim();

          // Which local name reaches the target: a bare pass-through, or a
          // name spread into the object literal built at the call.
          const forwarded = new Set();
          if (/^[A-Za-z_$][\w$]*$/.test(text)) forwarded.add(text);
          if (text.startsWith('{')) {
            const objOpen = b.indexOf('{', arg[0]);
            for (const k of topLevelKeys(b, objOpen)) {
              if (k.name !== '<spread>') continue;
              const after = b.slice(k.index + 3).match(/^\s*([A-Za-z_$][\w$]*)/);
              if (after) forwarded.add(after[1]);
            }
          }
          if (!forwarded.size) continue;

          for (let idx = 0; idx < params.length; idx++) {
            const [s, e] = params[idx];
            const param = b.slice(s, e).trim();
            const plain = param.match(/^([A-Za-z_$][\w$]*)/);
            if (plain && forwarded.has(plain[1])) {
              targets.set(decl.name, { argIndex: idx, allowedKeys: new Set(target.allowedKeys) });
              grew = true;
              break;
            }
            if (!param.startsWith('{')) continue;
            const patOpen = b.indexOf('{', s);
            if (patOpen < 0 || patOpen > e) continue;
            const own = namedKeys(b, patOpen);
            if (!own.some((k) => forwarded.has(k))) continue;
            const allowed = new Set(target.allowedKeys);
            for (const k of own) allowed.add(k);
            targets.set(decl.name, { argIndex: idx, allowedKeys: allowed });
            grew = true;
            break;
          }
          if (targets.has(decl.name)) break;
        }
        if (targets.has(decl.name)) break;
      }
    }
  }

  targets.delete(ENTRY);
  return targets;
}

/**
 * Shapes 1 and 2: keys that reach the fixture (directly or through a wrapper)
 * and that nothing on the way there names.
 */
export function scanFixtureOptionKeys(src, fixtureOptions) {
  const b = blank(src);
  const wrappers = resolveForwarders(b, fixtureOptions);
  const targets = new Map([
    [ENTRY, { argIndex: ENTRY_ARG, allowedKeys: new Set(fixtureOptions) }],
    ...wrappers,
  ]);

  const findings = [];
  let sitesChecked = 0;
  for (const [name, target] of targets) {
    for (const site of callSites(b, name)) {
      const arg = site.args[target.argIndex];
      if (!arg) continue;
      if (!b.slice(arg[0], arg[1]).trim().startsWith('{')) continue;
      sitesChecked++;
      const objOpen = b.indexOf('{', arg[0]);
      for (const k of topLevelKeys(b, objOpen)) {
        if (k.name.startsWith('<')) continue;
        if (target.allowedKeys.has(k.name)) continue;
        findings.push({ line: lineOf(src, k.index), helper: name, key: k.name });
      }
    }
  }
  return { findings, sitesChecked, wrappers: [...wrappers.keys()] };
}

/**
 * Shape 3: any helper whose parameter is a destructuring pattern, called with
 * a key the pattern does not name. `exclude` skips the ones shapes 1 and 2
 * already cover, so a single dead key is not reported twice.
 */
export function scanDestructuringHelpers(src, { exclude = new Set() } = {}) {
  const b = blank(src);
  const helpers = new Map();
  for (const decl of declarations(b)) {
    if (exclude.has(decl.name)) continue;
    const parenClose = matchPair(b, decl.parenOpen);
    if (parenClose < 0) continue;
    for (const [idx, [s, e]] of splitTopLevel(b, decl.parenOpen, parenClose).entries()) {
      if (!b.slice(s, e).trim().startsWith('{')) continue;
      const patOpen = b.indexOf('{', s);
      if (patOpen < 0 || patOpen > e) continue;
      if (hasRest(b, patOpen)) continue;
      if (!helpers.has(decl.name)) helpers.set(decl.name, []);
      helpers.get(decl.name).push({ argIndex: idx, keys: new Set(namedKeys(b, patOpen)) });
    }
  }

  const findings = [];
  let sitesChecked = 0;
  for (const [name, patterns] of helpers) {
    for (const site of callSites(b, name)) {
      for (const pattern of patterns) {
        const arg = site.args[pattern.argIndex];
        if (!arg) continue;
        if (!b.slice(arg[0], arg[1]).trim().startsWith('{')) continue;
        sitesChecked++;
        const objOpen = b.indexOf('{', arg[0]);
        for (const k of topLevelKeys(b, objOpen)) {
          if (k.name.startsWith('<')) continue;
          if (pattern.keys.has(k.name)) continue;
          findings.push({ line: lineOf(src, k.index), helper: name, key: k.name });
        }
      }
    }
  }
  return { findings, sitesChecked, helpers: [...helpers.keys()] };
}

// ---------------------------------------------------------------------------
// The scan over this repo.
// ---------------------------------------------------------------------------

const fixtureSrc = readFileSync(FIXTURE_PATH, 'utf8');
const { declared, unread } = parseFixtureOptions(fixtureSrc);
const specFiles = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.mjs'));

test('every option the fixture declares is read in its body', () => {
  assert.deepEqual(
    unread,
    [],
    `setupStandardMockRoutes names these and never reads them, so passing one ` +
      `does nothing: ${unread.join(', ')}`,
  );
});

test('every option a spec routes into the fixture is one the fixture names', () => {
  const problems = [];
  let sitesChecked = 0;
  const wrappersFound = [];
  for (const file of specFiles) {
    const src = readFileSync(join(E2E_DIR, file), 'utf8');
    const scan = scanFixtureOptionKeys(src, declared);
    sitesChecked += scan.sitesChecked;
    wrappersFound.push(...scan.wrappers.map((w) => `${file}:${w}`));
    problems.push(...scan.findings.map((f) => `${file}:${f.line}  ${f.helper}({ ${f.key} })`));
  }

  // A scanner that silently stops matching looks exactly like a clean repo.
  // These floors sit well under the counts at the time of writing (339 call
  // sites, 17 wrappers); they exist to turn a parser regression red, not to
  // pin a number a spec author has to maintain.
  assert.ok(sitesChecked >= 150, `only ${sitesChecked} call sites scanned - the scanner is not running`);
  assert.ok(wrappersFound.length >= 10, `only ${wrappersFound.length} forwarding wrappers resolved - the scanner is not running`);

  assert.deepEqual(
    problems,
    [],
    `these keys are handed to setupStandardMockRoutes and discarded:\n${problems.join('\n')}`,
  );
});

test('no spec helper is handed a key its parameter pattern does not name', () => {
  const problems = [];
  let sitesChecked = 0;
  for (const file of specFiles) {
    const src = readFileSync(join(E2E_DIR, file), 'utf8');
    const forwarders = scanFixtureOptionKeys(src, declared).wrappers;
    const scan = scanDestructuringHelpers(src, {
      exclude: new Set([ENTRY, ...forwarders]),
    });
    sitesChecked += scan.sitesChecked;
    problems.push(...scan.findings.map((f) => `${file}:${f.line}  ${f.helper}({ ${f.key} })`));
  }
  assert.ok(sitesChecked >= 25, `only ${sitesChecked} helper call sites scanned - the scanner is not running`);
  assert.deepEqual(
    problems,
    [],
    `these keys reach a helper that never reads them:\n${problems.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// The scanner's own mutation check. A guard that has never fired proves as
// little as a test that has never gone red - and these assertions all pass
// vacuously if the walk stops finding anything.
// ---------------------------------------------------------------------------

const SYNTHETIC_FIXTURE = `
export async function setupStandardMockRoutes(page, {
  assignments = {},
  reports = {},
  neverRead = {},
} = {}) {
  await page.route('**/a', () => assignments);
  await page.route('**/b', () => reports);
}
`;

const SYNTHETIC_SPEC = `
async function openAdmin(page, opts = {}) {
  await setupStandardMockRoutes(page, { assignments: {}, ...opts });
}
async function openNew(page, opts = {}) {
  await openAdmin(page, opts);
}
async function openTracking(page, { sink, extra = {} } = {}) {
  await setupStandardMockRoutes(page, { reports: sink, ...extra });
}
async function serveRoster(page, { students = null }) {
  await page.route('**/roster', () => students);
}
test('planted', async ({ page }) => {
  await setupStandardMockRoutes(page, { assignments: {}, acceptances: {} });
  await openAdmin(page, { reports: {}, bogusForwarded: 1 });
  await openNew(page, { deepBogus: 1 });
  await openTracking(page, { sink: [], reports: {} });
  await serveRoster(page, { students: [], bogusHelperKey: 1 });
});
`;

test('the scanner sees a planted dead option at every depth', () => {
  const synthetic = parseFixtureOptions(SYNTHETIC_FIXTURE);
  assert.deepEqual(synthetic.unread, ['neverRead']);

  const scan = scanFixtureOptionKeys(SYNTHETIC_SPEC, synthetic.declared);
  assert.deepEqual(
    scan.findings.map((f) => f.key).sort(),
    ['acceptances', 'bogusForwarded', 'deepBogus'],
  );
  // `openNew` only reaches the fixture through `openAdmin`; without the
  // transitive resolve, `deepBogus` above is invisible.
  assert.deepEqual(scan.wrappers.sort(), ['openAdmin', 'openNew', 'openTracking']);

  const helpers = scanDestructuringHelpers(SYNTHETIC_SPEC, {
    exclude: new Set([ENTRY, ...scan.wrappers]),
  });
  assert.deepEqual(helpers.findings.map((f) => f.key), ['bogusHelperKey']);
});

test('the scanner does not flag a key its helper consumes itself', () => {
  const { declared: synthetic } = parseFixtureOptions(SYNTHETIC_FIXTURE);
  const clean = `
async function openTracking(page, { sink, extra = {} } = {}) {
  await setupStandardMockRoutes(page, { reports: sink, ...extra });
}
test('clean', async ({ page }) => {
  await setupStandardMockRoutes(page, { assignments: {} });
  await openTracking(page, { sink: [], reports: {}, extra: {} });
});
`;
  assert.deepEqual(scanFixtureOptionKeys(clean, synthetic).findings, []);
});
