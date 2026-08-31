// The device-flow proxy setting, why it must not throw, and why there are two.
//
// github.com/login/device/code and /login/oauth/access_token send no CORS
// headers, so a browser cannot call them directly and both are routed through
// a configurable proxy. The target URL is APPENDED, so the setting has to end
// at the parameter that receives it.
//
// On 2026-08-28 corsproxy.io withdrew its free tier: every request, GET and
// POST alike, began answering `401 {"error":"A valid API key is required"}`.
// Sign-in went down for every lecturer and every student. The fix is a keyed
// URL - and a keyed URL ends `&url=`, which the old `endsWith('?url=')` check
// rejected, so the check refused precisely the value needed to recover.
//
// The second half matters as much: the check used to `throw` at MODULE SCOPE in
// a file the whole SPA imports. A misconfigured secret was therefore a blank
// page with nothing written on it - the localToUtc mistake in the worst
// possible place. It is recorded now and reported when someone tries to sign
// in, where there is a card to show it in.
//
// The third half is why a fallback exists at all. The recovery everyone assumes
// is available - point the setting at a different public proxy - was measured
// and does not exist: allorigins, thingproxy and codetabs each silently issue a
// GET and return GitHub's HTML sign-in page. So the fallback is a PXL-owned
// Cloudflare Worker (cors-worker/), and the pair is ordered rather than a set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTH = join(root, "frontend", "src", "lib", "auth.js");
const DEPLOY = join(root, ".github", "workflows", "deploy-frontend.yml");

/** The module's own normalise-and-validate, applied to a candidate setting. */
function accepts(value) {
  let proxy = value;
  if (proxy.endsWith("?")) proxy += "url=";
  return /[?&]url=$/.test(proxy);
}

test("a keyed proxy URL is accepted - the form that fixes the outage", () => {
  assert.ok(accepts("https://corsproxy.io/?key=abc123&url="), "a keyed proxy ends &url= and must be accepted");
});

test("the original and shorthand forms still work", () => {
  assert.ok(accepts("https://corsproxy.io/?url="));
  assert.ok(accepts("https://corsproxy.io/?"), "a trailing ? has url= appended");
});

test("a setting the target cannot be appended to is refused", () => {
  for (const bad of [
    "https://corsproxy.io/",
    "https://corsproxy.io/?target=",
    "https://corsproxy.io/?url",
    "https://corsproxy.io/?key=abc",
  ]) {
    assert.ok(!accepts(bad), `${bad} cannot receive the target URL and must be refused`);
  }
});

test("the module does not throw at import over a bad setting", () => {
  const src = readFileSync(AUTH, "utf8");
  const at = src.indexOf("function normalizeProxy(");
  assert.ok(at > 0, "the proxy setting must still be normalised here");
  const block = src.slice(at, src.indexOf("const GITHUB_API_BASE", at));

  assert.ok(
    !/throw new Error/.test(block),
    "throwing at module scope blanks the whole SPA - record the problem and report it at sign-in",
  );
  assert.match(block, /corsProxyError/, "the problem must be recorded");
  assert.match(block, /\[\?&\]url=\$/, "and both ?url= and &url= accepted");
});

test("the recorded problem is surfaced before any request is attempted", () => {
  // It moved out of startDeviceFlow when polling gained the same failover path,
  // but it still has to fire before the first fetch - otherwise a misconfigured
  // deployment reports a CORS error instead of the sentence naming the cause.
  const src = readFileSync(AUTH, "utf8");
  const fn = src.slice(src.indexOf("async function proxiedPost"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  assert.match(
    body,
    /if \(corsProxyError\) throw new Error\(corsProxyError\)/,
    "proxiedPost must fail with the configuration message rather than a CORS error",
  );
  assert.ok(
    body.indexOf("corsProxyError") < body.indexOf("fetchWithTimeout"),
    "the configuration check must precede the first request",
  );
});

test("the validation lives in one place", () => {
  // Two copies of "what a valid proxy setting looks like" is how the SPA and
  // the docs would drift apart on the exact thing that just broke.
  const src = readFileSync(AUTH, "utf8");
  const checks = [...src.matchAll(/\[\?&\]url=\$/g)].length;
  assert.equal(checks, 1, "expected exactly one place that decides whether the setting is usable");
});

test("the proxies are an ORDERED pair, and OURS is first", () => {
  // Order is the whole design, and it is a SECURITY property rather than a
  // preference: whichever proxy answers sees the device_code and the access
  // token in transit, and a lecturer token reads the private control repo -
  // roster names, student numbers, institutional email addresses.
  //
  // This test used to assert the opposite, because the PXL Worker shipped as the
  // FALLBACK. Measured live 2026-08-31 against the deployed SPA, that meant the
  // third party was on the path of every sign-in and the Worker was never
  // contacted at all - a fallback is only reached when the primary FAILS, and
  // corsproxy.io had started working again on a paid key. Reversing the pair is
  // the fix; this assertion is what stops it reverting.
  const src = readFileSync(AUTH, "utf8");
  const at = src.indexOf("const PROXIES = [");
  assert.ok(at > 0, "the proxy list must still be built here");
  const list = src.slice(at, src.indexOf("]", at));

  const ours = list.indexOf("DEVICE_FLOW_PROXY");
  const thirdParty = list.indexOf("VITE_CORS_PROXY_URL");
  assert.ok(ours > 0, "the PXL-owned Worker must be read, from deployment.yml");
  assert.ok(thirdParty > 0, "the third-party proxy must still be read, as the second entry");
  assert.ok(ours < thirdParty, "the PXL-owned Worker must come FIRST - see the comment above");
});

test("no hardcoded third-party proxy default survives", () => {
  // A default meant deleting the secret silently reinstated corsproxy.io as a
  // working primary, which is the state this change exists to leave.
  const src = readFileSync(AUTH, "utf8").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    src,
    /VITE_CORS_PROXY_URL\s*\|\|\s*['"]https?:\/\//,
    "the third-party proxy must have no hardcoded fallback URL",
  );
});

test("an unusable entry is skipped, not fatal", () => {
  // A typo in the fallback must not take working sign-in down with it - that is
  // the opposite of what a fallback is for.
  const src = readFileSync(AUTH, "utf8");
  assert.match(
    src,
    /const USABLE_PROXIES = PROXIES\.filter\(/,
    "unusable entries must be filtered out rather than raising a configuration error",
  );
  assert.match(
    src,
    /USABLE_PROXIES\.length > 0\s*\n?\s*\? null/,
    "it is only a configuration error when NOTHING usable is left",
  );
});

test("the fallback secret is actually passed by the deploy workflow", () => {
  // This is the claim-keys bug, one setting over: the SPA bakes the value in at
  // build time, so a fallback the build reads and the workflow never passes is
  // a fallback that ships to main and reaches nobody - discovered only when the
  // primary fails and the fallback turns out not to exist.
  const src = readFileSync(AUTH, "utf8");
  const deploy = readFileSync(DEPLOY, "utf8");

  const read = [...src.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)].map((m) => m[1]);

  // The pair is no longer two secrets. The PXL Worker moved to deployment.yml -
  // it was never secret, being baked into a public bundle - so the only VITE_
  // proxy setting left is the third-party SECOND entry. What this test protects
  // is unchanged and is the rule that matters: whatever auth.js reads from
  // import.meta.env, the deploy workflow has to pass, or it ships to main and
  // reaches nobody.
  assert.ok(
    !read.includes("VITE_CORS_PROXY_FALLBACK_URL"),
    "the fallback secret is retired - the PXL Worker is primary and lives in deployment.yml",
  );

  for (const name of new Set(read)) {
    assert.match(
      deploy,
      new RegExp(`^\\s*${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`, "m"),
      `${name} is baked in at build time, so deploy-frontend.yml must pass it`,
    );
  }
});

test("a proxy failure is told apart from GitHub refusing", () => {
  // Both are JSON with an `error` field - corsproxy.io's withdrawal reply was
  // `{"error":"A valid API key is required"}`. Accepting any `error` as GitHub's
  // answer would report a proxy's billing notice to a student as an
  // authorization failure, and would never fail over.
  const src = readFileSync(AUTH, "utf8");
  const at = src.indexOf("const OAUTH_ERRORS = new Set(");
  assert.ok(at > 0, "the allowlist of GitHub's own device-flow error codes must exist");
  const set = src.slice(at, src.indexOf(")", at));

  for (const code of ["authorization_pending", "slow_down", "expired_token", "access_denied"]) {
    assert.ok(set.includes(code), `${code} is a real GitHub device-flow code and must be accepted`);
  }
  assert.match(
    src,
    /OAUTH_ERRORS\.has\(/,
    "the token reply check must consult the allowlist rather than any truthy error",
  );
});
