// The institution is named in deployment.yml, and nowhere else.
//
// `institution_name` / `institution_short` were added on 2026-09-03 because a
// dozen user-facing strings said "your school email address", "your school
// GitHub account", "your official Hogeschool PXL address" and, in the student
// diagnostics, "@student.pxl.be" as a worked example. A fork editing
// deployment.yml - which its own header promises is the only file they need to
// touch - would have kept telling their students to use somebody else's
// institution.
//
// TWO things this pins, and they are different:
//
//   1. Nothing user-facing hardcodes the institution. It reads INSTITUTION or
//      INSTITUTION_SHORT, which come from the file.
//   2. MANUAL.md names no institution AT ALL. It is product documentation
//      rendered in the help drawer, so it is generic by design - "institutional
//      email address" - and cannot interpolate anyway.
//
// The PRODUCT name is not the institution and is deliberately exempt:
// deployment.yml's header says "The product name stays PXL Classroom. That is
// the software; this file is the deployment." A fork runs PXL Classroom at
// their own institution. The exemption is DERIVED from config.js rather than
// spelled here, so renaming the product cannot leave this test enforcing a name
// nothing uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const deployment = parse(read("deployment.yml")) ?? {};
const LONG = deployment.institution_name;
const SHORT = deployment.institution_short;
const DOMAINS = deployment.claim_domains ?? [];

/** The product name, taken from the SPA's own config so a rename follows. */
const PRODUCT = /appName:\s*'([^']+)'/.exec(read("frontend/src/lib/config.js"))?.[1];

test("the deployment file actually names the institution", () => {
  // The floor. Every assertion below is built from these, so an empty value
  // would make the whole file pass by checking nothing.
  assert.ok(LONG && LONG.length > 2, "deployment.yml must set institution_name");
  assert.ok(SHORT && SHORT.length > 1, "deployment.yml must set institution_short");
  assert.ok(DOMAINS.length > 0, "deployment.yml must set claim_domains");
  assert.ok(PRODUCT && PRODUCT.length > 2, "the product name must still be readable from config.js");
  assert.notEqual(LONG, PRODUCT, "the institution is not the product");
});

/**
 * What a reader sees, with the product name and the comments removed.
 *
 * Comments are stripped because every one of these fixes carries a comment
 * quoting the string it removed - the trap that has now caught three guards in
 * this repo. The product name is stripped first so "PXL Classroom" does not
 * register as the institution's short name inside it.
 */
function prose(relPath) {
  return read(relPath)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .split(PRODUCT).join("«product»")
    // Secret and variable NAMES are not branding: PXL_APP_PRIVATE_KEY is what
    // the secret is actually called, and renaming it would break a deployment.
    .replace(/\bPXL_[A-Z0-9_]+/g, "«secret»");
}

// Dev-only, and it is fabricated cohort data: invented logins, orgs and repo
// names. `/sandbox` is gated behind import.meta.env.DEV (DESIGN.md §8), so no
// student ever reads it.
const EXEMPT = new Set(["SandboxView.vue"]);

test("no user-facing surface hardcodes the institution", () => {
  const dirs = ["frontend/src/views", "frontend/src/components"];
  let scanned = 0;

  for (const dir of dirs) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".vue"))) {
      if (EXEMPT.has(file)) continue;
      const text = prose(join(dir, file));
      scanned++;

      assert.ok(
        !text.includes(LONG),
        `${dir}/${file}: hardcodes "${LONG}" - read INSTITUTION from lib/deployment.js instead`,
      );
      // The short form on its own. Inside the product name it is already gone.
      assert.ok(
        !new RegExp(`\\b${SHORT}\\b`).test(text),
        `${dir}/${file}: hardcodes "${SHORT}" - read INSTITUTION_SHORT from lib/deployment.js instead`,
      );
      for (const domain of DOMAINS) {
        assert.ok(
          !text.includes(domain),
          `${dir}/${file}: hardcodes the domain "${domain}" - it belongs to this deployment, ` +
            `so read CLAIM_DOMAINS (a worked example for a student comes from CLAIM_DOMAINS[0])`,
        );
      }
    }
  }

  assert.ok(scanned >= 15, `only ${scanned} components scanned - the sweep has broken, not the code`);
});

test("the hub's own student-facing text reads it too", () => {
  // accept.mjs's rejection reasons are read by a lecturer, and `no-claim` is
  // the one the student's page renders from the published category.
  const text = prose("acceptance/accept.mjs");
  assert.ok(!text.includes(LONG), "accept.mjs hardcodes the institution");
  assert.match(read("acceptance/accept.mjs"), /INSTITUTION/, "accept.mjs must read it from lib/deployment.mjs");
});

test("MANUAL.md names no institution at all", () => {
  // Product documentation, rendered in the help drawer, and a static file that
  // cannot interpolate - so it is generic rather than templated. It said "their
  // school email address" and "no school address", which is the same defect
  // worded vaguely: a fork's reader is not at a "school" either.
  const text = prose("MANUAL.md");
  assert.ok(!text.includes(LONG), `MANUAL.md names "${LONG}"; it should say "institutional"`);
  assert.ok(
    !new RegExp(`\\b${SHORT}\\b`).test(text),
    `MANUAL.md names "${SHORT}" outside the product name; it should say "institutional"`,
  );
  for (const domain of DOMAINS) {
    assert.ok(!text.includes(domain), `MANUAL.md names this deployment's domain "${domain}"`);
  }
  // And it must still be talking about the right thing.
  assert.match(read("MANUAL.md"), /institutional email address/, "the Claim mode description");

  // The product name IS allowed, and is expected to still be there - otherwise
  // the strip above is exempting something absent and the assertions are weaker
  // than they look.
  assert.ok(read("MANUAL.md").includes(PRODUCT), `MANUAL.md should still name the product`);
});

test("both readers of the file agree, and neither invents a third spelling", () => {
  // One value, two consumers - the SPA (build-time inlined) and the hub
  // (node:fs). A third copy is the shape this repo has paid for repeatedly.
  for (const f of ["frontend/src/lib/deployment.js", "lib/deployment.mjs"]) {
    const src = read(f);
    assert.match(src, /institution_name/, `${f} must read institution_name`);
    assert.match(src, /institution_short/, `${f} must read institution_short`);
    // A fork that forgets the keys must get something true, not this
    // deployment's name baked in as a default.
    //
    // BLOCK comments stripped as well, not just line comments: the docstring on
    // those very exports explains the rule by quoting "PXL", so a scan that
    // reads it fails against its own explanation. Third time in one day.
    assert.ok(
      !new RegExp(`["'][^"']*\\b${SHORT}\\b[^"']*["']`).test(
        src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
      ),
      `${f} falls back to "${SHORT}" - a fork that forgets the key would be branded ours`,
    );
  }
});
