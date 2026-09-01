import { parse } from "yaml";
import { readUtf8OrFail } from "./lib/encoding.mjs";
import { sameLogin } from "../lib/github-login.mjs";

const orgLogin = process.argv[2];
if (!orgLogin) {
  console.error("Usage: node get-budget-owner.mjs <org-login>");
  process.exit(2);
}

try {
  const o = parse(readUtf8OrFail("participating-orgs.yml"));
  // `sameLogin`, not `===`: a GitHub login is case-insensitive, and the registry
  // keeps whatever spelling the org was registered with. A caller passing
  // `pxl-foo` against a recorded `PXL-Foo` found nothing, printed an empty
  // owner, and weekly-usage-report.yml then had nobody to notify about a budget
  // - the quietest possible failure for an alert. `o?.orgs`, too: an empty
  // registry parses to null, and get-participating-orgs.mjs already guards it.
  const entry = (o?.orgs || []).find((x) => sameLogin(x.login, orgLogin));
  process.stdout.write(entry?.budget_owner_login || "");
} catch (err) {
  if (err.code === "ENOENT") {
    process.stdout.write("");
    process.exit(0);
  }
  console.error(err.message);
  process.exit(1);
}
