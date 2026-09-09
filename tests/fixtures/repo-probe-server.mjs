#!/usr/bin/env node
// A GitHub stand-in for the two reads `acceptance/accept.mjs` step 7 makes.
//
// IT RUNS AS ITS OWN PROCESS, and that is the whole reason it exists. The
// acceptance tests drive accept.mjs with `spawnSync`, which blocks the test's
// event loop until the child exits - so an in-process fake server never gets to
// answer and the run deadlocks until the timeout, with no output. (Learned once
// already, on the deadline drill; LESSONS.md.) A separate process keeps
// listening while the parent is blocked.
//
// Before this existed those tests reached the REAL api.github.com: no token, so
// a 401, which accept.mjs correctly reads as "unreadable" and refuses. Roughly
// 700ms of network latency per test, and a suite that failed differently
// depending on whether the machine was online.
//
// The fixture is re-read ON EVERY REQUEST rather than captured at startup, so
// one server serves a whole test file and a test changes the answers by
// rewriting the file immediately before it spawns accept.mjs. With spawnSync
// there is no race to lose: the write has returned before the child starts.
//
// Fixture shape, all optional:
//
//   { "repos": { "portfolio-alice": { "rulesets": ["pxl-classroom-deadline"] } } }
//
// A name present means the repository exists; `rulesets` names what
// `GET /repos/{o}/{r}/rulesets` returns. Absent file, absent name: 404, which is
// what every test that does not care about this wants.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const fixturePath = process.env.PROBE_FIXTURE || "";

function fixture() {
  if (!fixturePath) return { repos: {} };
  try {
    const parsed = JSON.parse(readFileSync(fixturePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : { repos: {} };
  } catch {
    // Not written yet, or mid-write. Nothing exists.
    return { repos: {} };
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  const repos = fixture().repos || {};

  // GET /repos/{org}/{repo}/rulesets
  let m = /^\/repos\/[^/]+\/([^/]+)\/rulesets$/.exec(path);
  if (m) {
    const entry = repos[m[1]];
    if (!entry) return json(res, 404, { message: "Not Found" });
    // A repository that is there while its rulesets are not readable is a real
    // state, not a contrivance: it is what an App without `administration`
    // sees, and reportedly what a free organization answers for a private
    // repository. `status` covers the same for the repository read itself.
    if (entry.rulesetsStatus) return json(res, entry.rulesetsStatus, { message: "Forbidden" });
    const names = Array.isArray(entry.rulesets) ? entry.rulesets : [];
    return json(
      res,
      200,
      names.map((name, i) => ({ id: 100 + i, name, target: "branch", source_type: "Repository" })),
    );
  }

  // GET /repos/{org}/{repo}
  m = /^\/repos\/[^/]+\/([^/]+)$/.exec(path);
  if (m) {
    const entry = repos[m[1]];
    if (!entry) return json(res, 404, { message: "Not Found" });
    // 4xx ONLY in fixtures. lib/gh.mjs retries anything >= 500 six times with
    // backoff, so staging a 500 here buys minutes of sleeping and a test that
    // looks hung rather than the refusal it is trying to assert.
    if (entry.status) return json(res, entry.status, { message: "Forbidden" });
    return json(res, 200, { id: entry.id ?? 4242, name: m[1] });
  }

  // 4xx, NEVER 5xx. lib/gh.mjs retries anything >= 500 six times with backoff,
  // so a catch-all of 599 turns one unexpected request into minutes of sleeping
  // and a test that looks hung.
  return json(res, 400, { message: `unexpected request: ${req.method} ${path}` });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  // The parent waits for this line to know the port. stdout, one line, first.
  process.stdout.write(`ready http://127.0.0.1:${port}\n`);
});
