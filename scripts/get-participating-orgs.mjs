import { readFileSync } from "node:fs";
import { parse } from "yaml";

try {
  const o = parse(readFileSync("participating-orgs.yml", "utf8"));
  process.stdout.write(JSON.stringify((o.orgs || []).map(x => x.login)));
} catch (e) {
  process.stdout.write("[]");
}
