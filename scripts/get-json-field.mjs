import { readFileSync } from "node:fs";

const [file, field] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf-8'));
console.log(d[field]);
