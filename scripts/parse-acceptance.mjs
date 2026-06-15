import { readFileSync, appendFileSync } from "node:fs";

const file = process.argv[2];
const d = JSON.parse(readFileSync(file, 'utf-8'));
const fsOut = process.env.GITHUB_OUTPUT;
appendFileSync(fsOut, `assignment_id=${d.assignment_id}\n`);
appendFileSync(fsOut, `github_login=${d.github_login}\n`);
