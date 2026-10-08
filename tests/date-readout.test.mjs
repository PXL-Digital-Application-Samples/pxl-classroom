// frontend/src/lib/date-readout.js: the line under a date-time box, which the
// browser draws in its own language (AM/PM in a US-English Chrome).

import { test } from "node:test";
import assert from "node:assert/strict";
import { dateReadout } from "../frontend/src/lib/date-readout.js";

test("24-hour, the day before the month, with the weekday", () => {
  const s = dateReadout("2026-10-09T21:30");
  assert.match(s, /\b21:30\b/, s);
  assert.doesNotMatch(s, /\b(AM|PM|am|pm)\b/, s);
  assert.match(s, /9 Oct 2026/, s);
  assert.match(s, /^Fri\b/, s);
});

test("midnight is 00:00, never 24:00", () => {
  assert.match(dateReadout("2026-10-12T00:00"), /\b00:00\b/);
});

test("nothing to say about an empty or unreadable box", () => {
  for (const v of ["", null, undefined, "garbage", "2026-13-45T99:99"]) {
    assert.equal(dateReadout(v), "", String(v));
  }
});

test("where students see another clock, the same moment there too - and only then", () => {
  const here = dateReadout("2026-10-09T09:30");
  // The same zone, or none named: just this computer's time.
  assert.equal(dateReadout("2026-10-09T09:30", { studentTimeZone: "Europe/Brussels", browserTimeZone: "Europe/Brussels" }), here);
  assert.equal(dateReadout("2026-10-09T09:30", { studentTimeZone: null }), here);
  // A zone 14 hours east of UTC is a different wall time from anywhere a test runs.
  const far = dateReadout("2026-10-09T09:30", { studentTimeZone: "Pacific/Kiritimati", browserTimeZone: "Europe/Brussels" });
  assert.match(far, new RegExp(`^${here.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(.+ for students\\)$`), far);
  // A zone the browser does not know is not a reason to say nothing.
  assert.equal(dateReadout("2026-10-09T09:30", { studentTimeZone: "Not/AZone", browserTimeZone: "Europe/Brussels" }), here);
});
