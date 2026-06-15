import { readFileSync, writeFileSync } from "node:fs";

const [file, field, value] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf-8'));
d[field] = value;
writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
