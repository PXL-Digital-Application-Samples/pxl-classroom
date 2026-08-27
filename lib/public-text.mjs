// PXL Classroom - what may appear in a field that gets published.
//
// GitHub Pages is public (§2 - access-controlled Pages is an Enterprise feature
// this system never uses), so an assignment's title and description are
// world-readable. pages/scan.mjs is the publish gate that enforces that, and it
// does its job: it blocked a publish because a lecturer had written
// "Questions? Mail tom.cool@pxl.be" into a description.
//
// The problem was everything after the block. The scanner runs over generated
// output, so the failure named a digest-shaped filename and a rule id, the
// `pages` action exited 1, the whole org's dashboard regeneration failed, and
// the site redeployed with stale data - for a sentence a lecturer would type
// without a second thought, in a UI that had accepted it happily.
//
// So the same rules live here, and three surfaces use them:
//
//   AdminView.fieldErrors   - refuses it at authoring time, where it can be fixed
//   pages/generate.mjs      - fails naming the assignment and the field
//   pages/scan.mjs          - the backstop, unchanged in what it catches
//
// Dependency-free and isomorphic: the SPA bundles it.

export const PUBLIC_TEXT_RULES = [
  {
    name: "email-address",
    // What a lecturer will actually hit, and the reason this module exists.
    label: "an email address",
    advice: "Point students at a channel instead - Toledo, Canvas, or the course issue tracker.",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    allow: /@users\.noreply\.github\.com$/,
  },
  {
    name: "invitation-token",
    label: "something shaped like an invitation token",
    advice: "The invitation is distributed as a link, never pasted into a field that gets published.",
    re: /\b[A-Za-z0-9_-]{35}\.[A-Za-z0-9_-]{86}\b/g,
  },
  {
    // The invitation is a PRIVATE KEY now (ARCHITECTURE §4.3.2), and the rule
    // above cannot see it - it is keyed on the old `<35>.<86>` shape, so a
    // leaked key would have passed the publish gate silently.
    //
    // Anchored on the DER header rather than on length: a PKCS#8 P-256 key is a
    // fixed structure, so these 36 characters are identical in every key ever
    // minted (confirmed over 200 mints) and nothing else produces them. That
    // makes a partial paste a finding too, where a length rule would miss it.
    // The same bytes base64 and base64url identically in this region, so a PEM
    // body is caught as well.
    //
    // The PUBLIC half starts `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE` and is
    // deliberately NOT matched: it lives on a public broker as INVITE_PUBKEY
    // and publishing it costs nothing. Flagging it would put a permanent false
    // positive beside the real ones.
    name: "invitation-key",
    label: "an invitation key",
    advice: "The invitation is distributed as a link, never pasted into a field that gets published.",
    re: /MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEH[A-Za-z0-9_+/-]*/g,
  },
  {
    name: "github-token",
    label: "a GitHub token",
    advice: "Revoke it - anything pasted here would have been published.",
    re: /\bgh[posu]_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: "github-fine-grained-pat",
    label: "a GitHub personal access token",
    advice: "Revoke it - anything pasted here would have been published.",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: "private-key",
    label: "a private key",
    advice: "Rotate it - anything pasted here would have been published.",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
];

/**
 * The first rule this text trips, or null.
 *
 * @returns {{name: string, label: string, advice: string, match: string} | null}
 */
export function findPublicTextViolation(text) {
  if (typeof text !== "string" || !text) return null;
  for (const rule of PUBLIC_TEXT_RULES) {
    // Fresh regex per call: the shared literals carry /g, and a lastIndex left
    // over from a previous test would make the next call skip the start of the
    // string - which reads as "sometimes it catches it".
    const re = new RegExp(rule.re.source, rule.re.flags);
    for (const m of text.matchAll(re)) {
      if (rule.allow && rule.allow.test(m[0])) continue;
      return { name: rule.name, label: rule.label, advice: rule.advice, match: m[0] };
    }
  }
  return null;
}

/** One sentence a lecturer can act on, naming the field and what was found. */
export function publicTextMessage(field, violation) {
  return (
    `The ${field} contains ${violation.label} ("${violation.match}"). ` +
    `It is published on a public page, so it cannot be saved as written. ${violation.advice}`
  );
}
