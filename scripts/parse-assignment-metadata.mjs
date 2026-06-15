import { readFileSync, appendFileSync } from "node:fs";
import { parse } from "yaml";

const [assignmentId, githubLogin] = process.argv.slice(2);
const a = parse(readFileSync(`control/assignments/${assignmentId}.yml`, "utf8"));
const fsOut = process.env.GITHUB_OUTPUT;

appendFileSync(fsOut, `template_owner=${a.template.owner}\n`);
appendFileSync(fsOut, `template_repository=${a.template.repository}\n`);

const pat = a.repository_name_pattern || `${assignmentId}-{login}`;
const targetRepo = pat.replace('{login}', githubLogin);
appendFileSync(fsOut, `target_repo=${targetRepo}\n`);
