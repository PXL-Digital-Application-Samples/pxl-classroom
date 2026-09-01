// The org registry is the list every org-fanout workflow reads. Appending to it
// used to be shell - `od` for magic bytes, `iconv`, `tr -d '\r'`, a `sed` to
// unpick `orgs: []`, a `grep` for the dedup - and none of that could be tested.
//
// It still CONCATENATES rather than serialises, which is forced: setup-org.yml
// deliberately runs with no `npm ci`, so it cannot have the `yaml` library.
// What changed is that the concatenation is now something a test can drive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { decode, existingLogins, register } from "../scripts/register-participating-org.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const HEADER = "schema_version: 1\norgs:\n";
const entry = (login, owner) => `  - login: ${login}\n    budget_owner_login: ${owner}\n`;

test("an empty or absent registry becomes a well-formed one", () => {
  const { text, added } = register("", "PXL-Alpha", "lecturer");
  assert.equal(added, true);
  assert.equal(text, HEADER + entry("PXL-Alpha", "lecturer"));
});

test("a second org is appended, not replacing the first", () => {
  const first = register("", "PXL-Alpha", "alice").text;
  const { text, added } = register(first, "PXL-Beta", "bob");
  assert.equal(added, true);
  assert.deepEqual(existingLogins(text), ["PXL-Alpha", "PXL-Beta"]);
});

test("registering the same org twice is a no-op", () => {
  const once = register("", "PXL-Alpha", "alice").text;
  const { text, added } = register(once, "PXL-Alpha", "alice");
  assert.equal(added, false);
  assert.equal(text, once);
});

test("a GitHub login is compared case-insensitively", () => {
  // The shell this replaced matched the raw string. `PXL-Alpha` over an
  // existing `pxl-alpha` would have written a SECOND entry for one
  // organisation, and every fanout workflow reads this list - so that org
  // would have been provisioned, billed and reported twice.
  const once = register("", "pxl-alpha", "alice").text;
  const { text, added } = register(once, "PXL-ALPHA", "alice");
  assert.equal(added, false);
  assert.deepEqual(existingLogins(text), ["pxl-alpha"]);
});

test("a flow-style empty list can still take an entry", () => {
  // `orgs: []` cannot take appended block entries - the result parses as a
  // list containing nothing, with the new entry stranded after it.
  const { text } = register("schema_version: 1\norgs: []\n", "PXL-Alpha", "alice");
  assert.equal(text, HEADER + entry("PXL-Alpha", "alice"));
  assert.doesNotMatch(text, /\[\]/);
});

test("a registry with no schema_version gets one, keeping its orgs", () => {
  const { text } = register("orgs:\n" + entry("PXL-Old", "carol"), "PXL-Alpha", "alice");
  assert.match(text, /^schema_version: 1\n/);
  assert.deepEqual(existingLogins(text), ["PXL-Old", "PXL-Alpha"]);
});

test("a registry missing the orgs key gets one rather than a stranded entry", () => {
  const { text } = register("schema_version: 1\n", "PXL-Alpha", "alice");
  assert.equal(text, HEADER + entry("PXL-Alpha", "alice"));
});

test("a file with no trailing newline does not fuse two entries onto one line", () => {
  const { text } = register("schema_version: 1\norgs:\n  - login: PXL-Old\n    budget_owner_login: c", "PXL-New", "alice");
  assert.deepEqual(existingLogins(text), ["PXL-Old", "PXL-New"]);
  assert.doesNotMatch(text, /budget_owner_login: c {2}- login/);
});

test("UTF-16 and BOM registries decode instead of corrupting the first key", () => {
  // Both have turned up in a registry committed by hand from Windows, and
  // either one makes `schema_version` unparseable - which the old shell
  // handled with `od` and `iconv`.
  const body = HEADER + entry("PXL-Alpha", "alice");

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
  assert.equal(decode(utf16le), body);

  const be = Buffer.from(body, "utf16le");
  for (let i = 0; i + 1 < be.length; i += 2) { const b = be[i]; be[i] = be[i + 1]; be[i + 1] = b; }
  assert.equal(decode(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), body);

  assert.equal(decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")])), body);
  assert.equal(decode(Buffer.from(body, "utf8")), body);
});

test("CRs are stripped, because every match here is anchored", () => {
  const crlf = "schema_version: 1\r\norgs:\r\n  - login: PXL-Old\r\n    budget_owner_login: c\r\n";
  const text = decode(Buffer.from(crlf, "utf8"));
  assert.doesNotMatch(text, /\r/);
  // And the dedup still sees the existing org through what were CRLF endings.
  assert.equal(register(text, "PXL-Old", "c").added, false);
});

test("the entry it writes is the shape the readers expect", () => {
  // Two spaces of indent for the list item, four for the mapping under it.
  // A reader parses this file with the yaml library; this writer cannot.
  const { text } = register("", "PXL-Alpha", "alice");
  assert.match(text, /^ {2}- login: PXL-Alpha\n {4}budget_owner_login: alice\n$/m);
});

test("what the concatenation produces parses, and satisfies the schema", () => {
  // The point of the rule this file is the exception to. The writer cannot use
  // the yaml library, so the TEST does - parsing what was concatenated with the
  // same parser every reader uses, and validating it against the schema the
  // readers expect. Hand-written YAML that nothing parses back is how this goes
  // wrong, so it is checked on every shape above, not just the happy one.
  const cases = [
    register("", "PXL-Alpha", "alice").text,
    register(register("", "PXL-Alpha", "alice").text, "PXL-Beta", "bob").text,
    register("schema_version: 1\norgs: []\n", "PXL-Alpha", "alice").text,
    register("orgs:\n  - login: PXL-Old\n    budget_owner_login: carol\n", "PXL-Alpha", "alice").text,
    register("schema_version: 1\norgs:\n  - login: PXL-Old\n    budget_owner_login: c", "PXL-New", "alice").text,
  ];
  for (const text of cases) {
    const doc = parseYaml(text);
    assert.ok(Array.isArray(doc.orgs) && doc.orgs.length >= 1, `orgs did not parse as a list:\n${text}`);
    for (const o of doc.orgs) {
      assert.equal(typeof o.login, "string", `an entry parsed without a login:\n${text}`);
      assert.equal(typeof o.budget_owner_login, "string", `an entry parsed without a budget owner:\n${text}`);
    }
    const { valid, errors } = validateAgainst("participating-orgs", doc);
    assert.ok(valid, `schema rejected what the writer produced:\n${text}\n${JSON.stringify(errors, null, 2)}`);
  }
});
