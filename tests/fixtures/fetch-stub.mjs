// Installs a recording `fetch` before a script under test runs.
//
// Used as `NODE_OPTIONS=--import <this>` so a top-level-await script that calls
// main() on import can still be driven from a test. Routes come from
// FETCH_STUB_ROUTES (a JSON array of {match, status, body}), and every request
// is appended to the file named by FETCH_STUB_LOG so the test can assert on the
// call PATTERN - which is the point when the fix is "stop making N requests".

import { appendFileSync, readFileSync } from "node:fs";

const routes = JSON.parse(process.env.FETCH_STUB_ROUTES || "[]");
const logPath = process.env.FETCH_STUB_LOG;
// A route may fail its first `failTimes` requests with `failStatus` and answer
// after that: GitHub saying "not now" and then answering.
const served = new Map();

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (logPath) appendFileSync(logPath, `${init.method || "GET"} ${href}\n`);

  const route = routes.find((r) => new RegExp(r.match).test(href));
  const seen = route ? (served.get(route) ?? 0) : 0;
  if (route) served.set(route, seen + 1);
  const failing = route && seen < (route.failTimes ?? 0);
  const status = failing ? route.failStatus : route ? (route.status ?? 200) : 404;
  const payload = failing ? "<!DOCTYPE html><title>504 Gateway Time-out</title>" : route ? route.body : { message: "Not Found" };
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
};

// Some scripts read a participating-orgs file from disk; leave that alone.
export { readFileSync };
