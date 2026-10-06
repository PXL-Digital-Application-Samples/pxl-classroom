// PXL Classroom - a team's join code (group_config.require_join_code).
//
// Self-service teams were first come, first served: any student holding the
// invitation could join any team with a free place, and the student who made
// the team had no say. With `require_join_code`, a team a STUDENT creates gets
// a code, and joining it needs that code from someone in it. A team without a
// code - made before the setting, seeded or made by the lecturer - stays open:
// those are the lecturer's own arrangement, and teams already formed on a live
// assignment are not disrupted.
//
// The code is made in the creator's browser (so the page can show it at once,
// with nothing to wait for and nowhere a student can read it back from), sealed
// to the hub's key for the trip through the public broker issue
// (lib/claim.mjs `encryptTeamCode`), and stored in the team's manifest in the
// private control repository, where the lecturer sees it on the Teams tab.
//
// SIX CHARACTERS, THE LAST A CHECK. A refusal reaches the student's page only
// as "refused" (two outcome labels and no more, CLAUDE.md), so a mistyped code
// would send them to their lecturer. The check makes the page catch every
// single wrong character and every swap of two characters before anything is
// sent: weights 1..6 are distinct and nonzero modulo the prime 31, so neither
// change can leave the weighted sum at zero. That leaves 31^5 = 28,629,151
// codes, guessed one public issue and one hub run at a time against GitHub's
// limit on creating content - which is why a wrong code is not counted against
// the student's attempts (accept.mjs).
//
// Pure and isomorphic: the page and the hub import the same rules.

/** No 0/O, 1/I/L: what is read off a screen and typed again. A prime count. */
export const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const JOIN_CODE_LENGTH = 6;

const BASE = JOIN_CODE_ALPHABET.length; // 31
const valueOf = (ch) => JOIN_CODE_ALPHABET.indexOf(ch);

/** Weighted sum mod 31 of the first `n` characters, weights 1..n. */
function weighted(code, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (i + 1) * valueOf(code[i]);
  return sum % BASE;
}

// 6 * 26 = 156 = 5 * 31 + 1, so 26 is 6's inverse mod 31.
const INVERSE_OF_LAST_WEIGHT = 26;

/** The character that brings the weighted sum of `body` + it to zero. */
function checkCharacter(body) {
  const need = (BASE - weighted(body, body.length)) % BASE;
  return JOIN_CODE_ALPHABET[(need * INVERSE_OF_LAST_WEIGHT) % BASE];
}

/**
 * A new code, normalised (no separator). `randomBytes(n)` is injectable for
 * tests; by default WebCrypto's, which the page and Node both have.
 */
export function newJoinCode(randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  let body = "";
  while (body.length < JOIN_CODE_LENGTH - 1) {
    for (const b of randomBytes(8)) {
      // 248 = 8 * 31: anything above would favour the first eight characters.
      if (b < 248 && body.length < JOIN_CODE_LENGTH - 1) body += JOIN_CODE_ALPHABET[b % BASE];
    }
  }
  return body + checkCharacter(body);
}

/**
 * What a person typed, as the code it means: case and separators ignored.
 * "" for anything that is not six characters of the alphabet.
 */
export function normalizeJoinCode(input) {
  if (typeof input !== "string") return "";
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== JOIN_CODE_LENGTH) return "";
  for (const ch of code) if (valueOf(ch) < 0) return "";
  return code;
}

/** Well-formed and its check character agrees: what the page may send. */
export function isWellFormedJoinCode(input) {
  const code = normalizeJoinCode(input);
  return code !== "" && weighted(code, JOIN_CODE_LENGTH) === 0;
}

/** For reading aloud and copying: `K7P-4QX`. */
export function formatJoinCode(input) {
  const code = normalizeJoinCode(input);
  return code ? `${code.slice(0, 3)}-${code.slice(3)}` : "";
}

/**
 * Does the offered code open this team? Both normalised; compared in full
 * whatever the first difference, so the time taken says nothing about how
 * much of a guess was right.
 */
export function joinCodeMatches(stored, offered) {
  const a = normalizeJoinCode(stored);
  const b = normalizeJoinCode(offered);
  if (!a || !b) return false;
  let diff = 0;
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Does this assignment give the teams students create a code? Absent is no. */
export function requiresJoinCode(groupConfig) {
  return groupConfig?.require_join_code === true;
}

/**
 * Does joining this team need its code - now? Only while the assignment asks
 * for codes: unticking the setting opens every team, and ticking it again
 * closes the ones that have a code. A team with no code is open either way.
 *
 * A code that is THERE but unreadable - empty, null, or a manifest edited by
 * hand - still counts: it matches nothing, so the team takes nobody new until
 * the file is put right. Absent and empty are different answers (CLAUDE.md);
 * reading an empty one as "no code" would open the team instead.
 */
export function teamNeedsJoinCode(groupConfig, team) {
  return (
    requiresJoinCode(groupConfig) &&
    team !== null &&
    typeof team === "object" &&
    Object.prototype.hasOwnProperty.call(team, "join_code")
  );
}
