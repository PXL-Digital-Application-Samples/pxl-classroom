import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Aborting a fetch stops US waiting; it does NOT cancel the request at GitHub.
// So a timeout on a non-idempotent write leaves the app unable to say whether
// the write landed, and a retry can produce a second commit, a second PR, or a
// second Actions run. Reads carry no such hazard.
//
// The rule: bound reads, never writes. A write may opt in per call, but only
// deliberately and only where the endpoint is genuinely idempotent.

const LIB = join(process.cwd(), "frontend", "src", "lib");

const read = (f) => readFile(join(LIB, f), "utf8");

test("http: fetchWithTimeout defaults to waiting indefinitely", async () => {
  const src = await read("http.js");
  assert.match(
    src,
    /\{\s*timeoutMs = 0,/,
    "timeoutMs must default to 0 (wait forever). Defaulting to a number would " +
      "silently bound every caller, including writes.",
  );
  assert.match(
    src,
    /if \(!timeoutMs\) \{[\s\S]*?return fetch\(/,
    "with no timeout the helper must fall straight through to fetch()",
  );
  // A caller-initiated cancel must not be reported as a network timeout.
  assert.match(src, /let timedOut = false/);
  assert.match(src, /if \(timedOut\) throw new HttpTimeoutError/);
  // Plain AbortController keeps browser support wide. Match an actual call, not
  // the prose in the comment that explains this choice.
  assert.ok(
    !/AbortSignal\s*\.\s*(timeout|any)\s*\(/.test(src),
    "use a plain AbortController so the helper does not depend on newer signal APIs",
  );
});

test("http: ghApi bounds reads and leaves writes unbounded", async () => {
  const src = await read("api.js");
  assert.match(
    src,
    /options\.timeoutMs \?\? \(method === 'GET' \? READ_TIMEOUT_MS : 0\)/,
    "ghApi must apply READ_TIMEOUT_MS to GET only, and 0 (unbounded) to every " +
      "other method unless the caller explicitly overrides it.",
  );
});

test("http: no write call site silently opts into a timeout", async () => {
  const files = ["api.js", "auth.js"];
  const offenders = [];

  for (const f of files) {
    const src = await read(f);
    // ghApi(..., 'POST'|'PUT'|'PATCH'|'DELETE', ...) must not pass timeoutMs.
    for (const m of src.matchAll(/ghApi\([^)]*'(POST|PUT|PATCH|DELETE)'[^;]*?\)/gs)) {
      if (/timeoutMs/.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 70)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "A write opting into a timeout must be a deliberate, reviewed decision - " +
      "add it to this test's allowlist with the reason it is idempotent.",
  );
});

test("http: the device-flow poll is bounded and cancellable", async () => {
  const src = await read("auth.js");
  const poll = src.match(/export async function pollDeviceFlow\([\s\S]*?\n\}/)?.[0];
  assert.ok(poll, "auth.js must export pollDeviceFlow");

  // Polling IS the retry, so bounding a tick is safe - and required, because a
  // stalled tick previously stranded sign-in with no way out.
  assert.match(
    poll,
    /timeoutMs: POLL_TIMEOUT_MS, signal/,
    "each poll must carry both a timeout and the caller's abort signal; without " +
      "the signal on the request, Cancel does nothing until the fetch resolves",
  );
  assert.match(
    poll,
    /if \(err instanceof HttpTimeoutError\) continue/,
    "a slow tick is not a failed sign-in - the user may still be authorizing, " +
      "so the loop must retry rather than throw",
  );
  assert.match(
    poll,
    /if \(signal\?\.aborted\) throw new Error\('Cancelled'\)/,
    "an abort during the request must surface as Cancelled, not as a timeout",
  );
});

test("http: every GitHub fetch in the client goes through fetchWithTimeout", async () => {
  const offenders = [];
  for (const f of ["api.js", "auth.js"]) {
    const src = await read(f);
    src.split("\n").forEach((line, i) => {
      if (/\bawait fetch\(/.test(line)) offenders.push(`${f}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "A bare fetch() has no bound at all. Route it through fetchWithTimeout - " +
      "passing timeoutMs: 0 if it genuinely must wait forever.",
  );
});
