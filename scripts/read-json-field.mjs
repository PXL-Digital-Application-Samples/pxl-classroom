// Read one top-level field out of a JSON document and print it.
//
// The counterpart to update-json-field.mjs, and it exists for the same reason
// that one does: this used to be inline in publish-assignment.yml as
//
//     STATE=$(node -p "require('./$JSON').state || ''" 2>/dev/null || true)
//
// which breaks two rules at once. `node -p` is inline JS in workflow YAML, and
// `$JSON` was composed into the JS source TEXT - the shell substitutes it
// before node parses anything, so the question is never "can that value be
// hostile" but "is it a literal I wrote". It also swallowed every error into an
// empty string: a corrupt or unreadable assignment file read as "no prior
// state", and the revert that depends on this value then had nothing to
// restore, silently. Unreadable is not evidence.
//
// So: an absent FIELD prints nothing and exits 0, which is a real answer. A
// file that cannot be read or parsed exits non-zero and says so.
import { readFileSync } from "node:fs";

const [file, field] = process.argv.slice(2);

if (!file || !field) {
  console.error("usage: read-json-field.mjs <file> <field>");
  process.exit(2);
}

let doc;
try {
  doc = JSON.parse(readFileSync(file, "utf-8"));
} catch (e) {
  console.error(`Could not read ${file} as JSON: ${e.message}`);
  process.exit(1);
}

const value = doc?.[field];
if (value === undefined || value === null) process.exit(0);

if (typeof value === "object") {
  console.error(`${field} in ${file} is ${Array.isArray(value) ? "an array" : "an object"}, not a scalar`);
  process.exit(1);
}

process.stdout.write(String(value));
