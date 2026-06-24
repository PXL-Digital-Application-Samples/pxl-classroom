import { readFileSync, writeFileSync } from "node:fs";
import { validateAgainst } from "../lib/validate.mjs";

const args = process.argv.slice(2);
let schemaName;
if (args[0] === '--schema') {
  schemaName = args[1];
  args.splice(0, 2);
}

const [file, field, value] = args;
const d = JSON.parse(readFileSync(file, 'utf-8'));
d[field] = value;

if (schemaName) {
  const { valid, errors } = validateAgainst(schemaName, d);
  if (!valid) {
    console.error(`Validation failed for ${schemaName}:`);
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
  }
}

writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
