import { parse } from "yaml";
import { readUtf8OrFail } from "./lib/encoding.mjs";

const orgLogin = process.argv[2];
if (!orgLogin) {
  console.error("Usage: node get-budget-owner.mjs <org-login>");
  process.exit(2);
}

try {
  const o = parse(readUtf8OrFail("participating-orgs.yml"));
  const entry = (o.orgs || []).find(x => x.login === orgLogin);
  process.stdout.write(entry?.budget_owner_login || "");
} catch (err) {
  if (err.code === "ENOENT") {
    process.stdout.write("");
    process.exit(0);
  }
  console.error(err.message);
  process.exit(1);
}
