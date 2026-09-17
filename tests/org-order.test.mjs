// frontend/src/lib/org-order.js - the organization switcher's order.
//
// Asked for 2026-09-17: green lamps first, then amber, then unlit, A-Z within
// each. It was the order GitHub listed the App's installations in.

import { test } from "node:test";
import assert from "node:assert/strict";

import { lampRank, orderOrgsForSwitcher } from "../frontend/src/lib/org-order.js";

const orgs = (...logins) => logins.map((login) => ({ login }));
const byStatus = (statuses) => (login) => lampRank(statuses[login]);

test("green, then amber, then unlit", () => {
  const statuses = { Empty: "empty", Closed: "inactive", Live: "active" };
  const ordered = orderOrgsForSwitcher(orgs("Empty", "Closed", "Live"), byStatus(statuses));
  assert.deepEqual(ordered.map((o) => o.login), ["Live", "Closed", "Empty"]);
});

test("every state that draws no lit lamp is one group", () => {
  // empty (hollow), no-access (dashed), unknown (not loaded yet) all look unlit,
  // so they sort together and alphabetically - the order follows what is seen.
  for (const status of ["empty", "no-access", "unknown", undefined, "something-new"]) {
    assert.equal(lampRank(status), 2, String(status));
  }
  assert.ok(lampRank("active") < lampRank("inactive"));
  assert.ok(lampRank("inactive") < lampRank("empty"));
});

test("A-Z within a group, ignoring case", () => {
  // ASCII would put "PXL-Gamma" before "PXL-beta"; a person reading the list would not.
  const statuses = { "PXL-Gamma": "inactive", "PXL-beta": "inactive", "PXL-Alpha": "inactive" };
  const ordered = orderOrgsForSwitcher(orgs("PXL-Gamma", "PXL-beta", "PXL-Alpha"), byStatus(statuses));
  assert.deepEqual(ordered.map((o) => o.login), ["PXL-Alpha", "PXL-beta", "PXL-Gamma"]);
});

test("the group decides before the name does", () => {
  const statuses = { "PXL-Aardvark": "empty", "PXL-Zebra": "active" };
  const ordered = orderOrgsForSwitcher(orgs("PXL-Aardvark", "PXL-Zebra"), byStatus(statuses));
  assert.deepEqual(ordered.map((o) => o.login), ["PXL-Zebra", "PXL-Aardvark"]);
});

test("the input is not reordered in place", () => {
  const input = orgs("B", "A");
  orderOrgsForSwitcher(input, () => 0);
  assert.deepEqual(input.map((o) => o.login), ["B", "A"]);
  assert.deepEqual(orderOrgsForSwitcher(null, () => 0), []);
});
