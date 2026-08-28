// The device-flow proxy setting, and why it must not throw.
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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTH = join(root, "frontend", "src", "lib", "auth.js");

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
  const at = src.indexOf("let CORS_PROXY =");
  assert.ok(at > 0, "the proxy setting must still be read here");
  const block = src.slice(at, src.indexOf("const GITHUB_API_BASE", at));

  assert.ok(
    !/throw new Error/.test(block),
    "throwing at module scope blanks the whole SPA - record the problem and report it at sign-in",
  );
  assert.match(block, /corsProxyError/, "the problem must be recorded");
  assert.match(block, /\[\?&\]url=\$/, "and both ?url= and &url= accepted");
});

test("the recorded problem is surfaced when sign-in is attempted", () => {
  const src = readFileSync(AUTH, "utf8");
  const fn = src.slice(src.indexOf("export async function startDeviceFlow"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(
    body,
    /if \(corsProxyError\) throw new Error\(corsProxyError\)/,
    "startDeviceFlow must fail with the configuration message rather than a CORS error",
  );
});

test("the validation lives in one place", () => {
  // Two copies of "what a valid proxy setting looks like" is how the SPA and
  // the docs would drift apart on the exact thing that just broke.
  const src = readFileSync(AUTH, "utf8");
  const checks = [...src.matchAll(/\[\?&\]url=\$/g)].length;
  assert.equal(checks, 1, "expected exactly one place that decides whether the setting is usable");
});
