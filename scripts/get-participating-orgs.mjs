import { readUtf8OrFail } from "./lib/encoding.mjs";

let text;
try {
  text = readUtf8OrFail("participating-orgs.yml");
} catch (err) {
  // Missing file is OK (bootstrap state); encoding errors are not.
  if (err.code === "ENOENT") {
    process.stdout.write("[]");
    process.exit(0);
  }
  console.error(err.message);
  process.exit(1);
}

const logins = [];
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*-\s*login:\s*"?([A-Za-z0-9][A-Za-z0-9-]*)"?\s*$/);
  if (m) logins.push(m[1]);
}
process.stdout.write(JSON.stringify(logins));
