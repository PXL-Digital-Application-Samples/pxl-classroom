import { parse } from "yaml";
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

const o = parse(text);
process.stdout.write(JSON.stringify((o?.orgs || []).map(x => x.login)));
