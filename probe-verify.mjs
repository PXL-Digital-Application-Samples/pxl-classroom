// Temporary: does the report the real generator just produced satisfy its own
// schema, and did the deadline numbers flow through?
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgainst } from "./lib/validate.mjs";

const S = process.argv[2];
const ID = "2526-examen-aut2-ek2";

const report = JSON.parse(readFileSync(join(S, "reports", `${ID}.json`), "utf8"));
const { valid, errors } = validateAgainst("report", report);
console.log(`  report validates against report.schema.json: ${valid}`);
for (const e of errors.slice(0, 6)) {
  console.log(`    ${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params || {})}`);
}

const s = report.students[0];
console.log(`  students: ${report.students.length}`);
console.log(`  lock_down_at:            ${s.lock_down_at}`);
console.log(`  lockdown_delay_seconds:  ${s.lockdown_delay_seconds}   (deadline -> writes actually stopped)`);
console.log(`  preservation_status:     ${s.preservation_status}`);
console.log(`  archive_repo:            ${s.archive_repo}`);

// The two numbers must never be the same measure - report-preservation pins it.
const distinct = s.lockdown_delay_seconds !== s.uncertainty_interval_seconds;
console.log(`  delay is not the same field as uncertainty_interval_seconds: ${distinct}`);

// Every student carries the archive coordinates, so the dashboard can link them.
const missing = report.students.filter((x) => x.preservation_status === "preserved" && !x.archive_repo);
console.log(`  preserved rows missing archive_repo: ${missing.length}`);

const dash = JSON.parse(readFileSync(join(S, "reports", "dashboard.json"), "utf8"));
const entry = dash.assignments[ID];
console.log(`  dashboard max_acceptances: ${entry.max_acceptances}  accepted: ${entry.accepted}/${entry.total_students}`);
