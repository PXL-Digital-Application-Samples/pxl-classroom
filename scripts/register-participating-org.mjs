// Add one organisation to `participating-orgs.yml`.
//
// This was ~40 lines of shell in setup-org.yml doing `od` magic-byte sniffing,
// `iconv`, `tr -d '\r'`, a `sed` to unpick `orgs: []`, a `grep` for the dedup
// and a `printf >>` for the append. It is the one place in the repo that
// concatenates YAML rather than serialising it, and that is FORCED, not an
// oversight: setup-org.yml deliberately runs with no `npm ci`, so the `yaml`
// library is not available to it (see tests/dependency-free-entrypoints).
//
// So the concatenation stays and the gymnastics go. Everything here is
// structured and testable, which the shell version could not be, and the file's
// shape is tiny and fixed:
//
//     schema_version: 1
//     orgs:
//       - login: <login>
//         budget_owner_login: <login>
//
// DEPENDENCY-FREE. `node:fs` and lib/github-login.mjs, which imports nothing.
// A bare specifier anywhere in this graph is a failed org onboarding, not a
// slow one.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizeLogin, sameLogin } from "../lib/github-login.mjs";

const LOGIN = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$/;
const HEADER = "schema_version: 1\norgs:\n";

/**
 * Decode whatever encoding the file arrived in to UTF-8 with LF endings.
 *
 * A registry committed by hand from Windows has turned up as UTF-16LE and as
 * UTF-8-with-BOM; either one makes the first key unparseable, and the CRs make
 * every anchored match miss.
 */
export function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return strip(buf.subarray(2).toString("utf16le"));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return strip(swap16(buf.subarray(2)).toString("utf16le"));
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return strip(buf.subarray(3).toString("utf8"));
  return strip(buf.toString("utf8"));
}

function swap16(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const b = out[i];
    out[i] = out[i + 1];
    out[i + 1] = b;
  }
  return out;
}

const strip = (s) => s.replace(/\r/g, "");

/** Every login already registered, in file order. */
export function existingLogins(text) {
  return [...text.matchAll(/^[ \t]*-[ \t]+login:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]);
}

/**
 * The registry text with `login` present.
 *
 * Returns `{ text, added }`. `added` is false when the org was already there -
 * the text may still differ, because normalising the encoding or an `orgs: []`
 * is a change worth committing on its own.
 */
export function register(text, login, budgetOwner) {
  let out = text;

  if (!out.trim()) out = HEADER;
  else if (!/^schema_version:/m.test(out)) out = `schema_version: 1\n${out}`;

  // A flow-style empty list cannot take appended block entries.
  out = out.replace(/^orgs:[ \t]*\[\][ \t]*$/m, "orgs:");
  if (!/^orgs:/m.test(out)) out = `${out.replace(/\n*$/, "\n")}orgs:\n`;
  if (!out.endsWith("\n")) out += "\n";

  // Case-insensitively, because a GitHub login is. The shell this replaced
  // matched the raw string, so registering PXL-Foo over an existing pxl-foo
  // would have written a second entry for the same organisation - and every
  // org-fanout workflow reads this list.
  if (existingLogins(out).some((l) => sameLogin(l, login))) return { text: out, added: false };

  return { text: `${out}  - login: ${login}\n    budget_owner_login: ${budgetOwner}\n`, added: true };
}

function main(argv) {
  const [file, login, budgetOwner] = argv;
  if (!file || !login || !budgetOwner) {
    console.error("usage: register-participating-org.mjs <file> <login> <budget_owner_login>");
    return 2;
  }
  // Validated here as well as in the workflow: this is the value that gets
  // written into YAML by concatenation, so the check belongs beside the write.
  for (const v of [login, budgetOwner]) {
    if (!LOGIN.test(v)) {
      console.error(`::error::'${v}' is not a valid GitHub login.`);
      return 1;
    }
  }

  const before = existsSync(file) ? decode(readFileSync(file)) : "";
  const { text, added } = register(before, login, budgetOwner);
  writeFileSync(file, text, "utf8");

  if (added) console.log(`Registered ${login} (budget owner ${budgetOwner}).`);
  else console.log(`${normalizeLogin(login)} is already registered.`);
  return 0;
}

// Only when run as a script, so the tests can import the pieces above.
// `pathToFileURL` rather than string-building a file:// URL: on Windows the
// hand-rolled form disagrees with import.meta.url about the drive letter.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
