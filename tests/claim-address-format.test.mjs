// The address FORM (deployment.yml `claim_address_format`): what the rule
// admits and refuses, pinned as a table, and how it is resolved per
// assignment. lib/claim.mjs `resolveAddressFormat`, `addressFormatAllowed`,
// `bindingMeetsRules`. The acceptance paths are tests/confirm-accept.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressFormatAllowed, bindingMeetsRules, resolveAddressFormat } from "../lib/claim.mjs";
import { CLAIM_ADDRESS_FORMAT } from "../lib/deployment.mjs";

const PXL = resolveAddressFormat({}, CLAIM_ADDRESS_FORMAT);

test("the deployment has a form, and it is the one this table pins", () => {
  assert.ok(PXL, "deployment.yml claim_address_format");
  assert.equal(CLAIM_ADDRESS_FORMAT.example, "firstname.lastname");
});

test("ADMITTED: an interior dot in the local part, whatever else it holds", () => {
  for (const email of [
    "alice.peeters@student.pxl.be",
    "Alice.Peeters@Student.PXL.be", // case is not the question
    "  alice.peeters@student.pxl.be  ", // surrounding space trimmed
    "jan.de.smet@student.pxl.be",
    "a..b@student.pxl.be",
    "élodie.dupré@student.pxl.be",
    // Accepted by design, recorded so a change is deliberate: the rule is
    // "not a bare number", not "a real name".
    "1234.5678@student.pxl.be",
    "first+x.y@student.pxl.be",
  ]) assert.equal(addressFormatAllowed(email, PXL), true, email);
});

test("REFUSED: no interior dot, a leading or trailing dot, or not an address", () => {
  for (const email of [
    "12345678@student.pxl.be",
    "alice@student.pxl.be",
    ".alice@student.pxl.be",
    "alice.@student.pxl.be",
    "12345678.@student.pxl.be",
    "@student.pxl.be",
    "alice.peeters",
    "",
    null,
  ]) assert.equal(addressFormatAllowed(email, PXL), false, String(email));
});

test("the LOCAL part only: a dot in the domain does not satisfy it", () => {
  assert.equal(addressFormatAllowed("12345678@student.pxl.be", PXL), false);
  assert.equal(addressFormatAllowed("a.b@c@d", PXL), false, "the last @ splits, and 'a.b@c' holds an @");
});

test("resolved per assignment: false opts out; absent or true is the deployment's", () => {
  assert.equal(resolveAddressFormat({ claim_address_format: false }, CLAIM_ADDRESS_FORMAT), null);
  assert.ok(resolveAddressFormat({ claim_address_format: true }, CLAIM_ADDRESS_FORMAT));
  assert.ok(resolveAddressFormat({}, CLAIM_ADDRESS_FORMAT));
  assert.equal(resolveAddressFormat({}, null), null, "no deployment rule, no rule");
  assert.equal(resolveAddressFormat({}, { pattern: "", example: "x" }), null);
  // An unreadable pattern is "no rule" here; lib/deployment.mjs refuses one at
  // load, so this is only reached by a caller that built its own.
  assert.equal(resolveAddressFormat({}, { pattern: "([", example: "x" }), null);
});

test("a pattern written with capitals still matches: the input is lowercased, the pattern is case-blind", () => {
  const caps = resolveAddressFormat({}, { pattern: "^[A-Z]+\\.[A-Z]+$", example: "first.last" });
  assert.equal(addressFormatAllowed("Alice.Peeters@student.pxl.be", caps), true);
});

test("no form required admits anything", () => {
  assert.equal(addressFormatAllowed("12345678@student.pxl.be", null), true);
});

test("bindingMeetsRules asks both rules, and a binding with no address meets nothing", () => {
  const rules = { domains: ["student.pxl.be"], format: PXL };
  assert.equal(bindingMeetsRules({ email: "alice.peeters@student.pxl.be" }, rules), true);
  assert.equal(bindingMeetsRules({ email: "12345678@student.pxl.be" }, rules), false);
  assert.equal(bindingMeetsRules({ email: "alice.peeters@gmail.com" }, rules), false);
  assert.equal(bindingMeetsRules({}, rules), false);
  assert.equal(bindingMeetsRules(null, rules), false);
});
