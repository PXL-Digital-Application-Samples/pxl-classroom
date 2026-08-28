// Temporary: will the sentinel arm for the live exam, using the real planner?
import { planSentinels } from "./scripts/find-armable.mjs";

const DEADLINE = "2026-08-30T20:00:00.000Z";
const ORG = "PXL-Automation-II";
const assignments = [{ id: "2526-examen-aut2-ek2", doc: { state: "published", deadline_at: DEADLINE } }];

let first = null;
for (let t = Date.parse("2026-08-30T00:00:00.000Z"); t <= Date.parse("2026-08-31T00:00:00.000Z"); t += 4 * 3600_000) {
  const { armed } = planSentinels(assignments, { now: t, org: ORG });
  const iso = new Date(t).toISOString().slice(11, 16);
  if (armed.length && first === null) first = t;
  console.log(`    cron ${iso}Z  ${armed.length ? "ARMS  key=" + armed[0].key : "-"}`);
}
const lead = (Date.parse(DEADLINE) - first) / 3600_000;
console.log(`    first arms ${lead}h before the deadline; the watch job waits up to 4.75h -> ${lead <= 4.75 ? "FITS" : "TOO LATE"}`);
