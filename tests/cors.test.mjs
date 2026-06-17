// PXL Classroom — CORS regression guard.
//
// github.com/login/device/code and github.com/login/oauth/access_token do NOT
// send CORS headers. A browser fetch directly to those URLs will fail with
// "Access to fetch ... has been blocked by CORS policy" and the SPA's
// device-flow sign-in will be entirely broken in production.
//
// This was a real regression in Wave 4 — the corsproxy.io workaround was
// removed without replacement, and nobody noticed until a user clicked Sign In
// in a deployed Pages site. This test exists to make the regression noisy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const authJsPath = join(here, "..", "frontend", "src", "lib", "auth.js");
const auth = readFileSync(authJsPath, "utf8");

test("auth.js references the device-flow endpoints", () => {
  assert.match(auth, /github\.com\/login\/device\/code/, "device-code endpoint URL must appear");
  assert.match(auth, /github\.com\/login\/oauth\/access_token/, "token endpoint URL must appear");
});

test("auth.js routes the device-flow endpoints through a CORS proxy", () => {
  // The proxy must be configurable (so operators can swap it) AND have a
  // working default (so the SPA isn't broken out of the box).
  assert.match(
    auth,
    /VITE_CORS_PROXY_URL/,
    "auth.js must read a VITE_CORS_PROXY_URL env var so the proxy is operator-configurable",
  );
  assert.match(
    auth,
    /corsproxy\.io|CORS_PROXY/,
    "auth.js must have a default CORS proxy or a CORS_PROXY constant — direct fetches to github.com/login/* are CORS-blocked",
  );
});

test("auth.js does NOT fetch github.com/login/* directly without proxying", () => {
  // Scan every fetch() call in auth.js. If it passes a github.com/login/* URL
  // literal as the first argument, the URL must come through the CORS proxy
  // variable (or be inside encodeURIComponent() called on that string).
  const fetchCalls = auth.match(/fetch\s*\(\s*[^)]+\)/g) || [];
  for (const call of fetchCalls) {
    const isLoginUrl =
      /['"`]https:\/\/github\.com\/login\/(device\/code|oauth\/access_token)['"`]/.test(call);
    if (!isLoginUrl) continue;
    // A direct string literal as the fetch URL means we're bypassing the proxy.
    assert.fail(
      `auth.js has a direct fetch() to a github.com/login/* URL string literal: ${call.slice(0, 120)}…\n` +
        `These endpoints don't support CORS. Route through CORS_PROXY / VITE_CORS_PROXY_URL.`,
    );
  }
});
