// PXL Classroom - is this an address GitHub issued so that it is NOT a mailbox?
//
// A commit made with email privacy on is authored as
// `<id>+<login>@users.noreply.github.com`. That names the account, never a
// person's inbox, so the collector drops it rather than record it as the
// student's address, and the cohort table drops it rather than show it as one.
//
// It was `address.includes("noreply.github.com")`, written three times:
// collect.mjs, and twice in AssignmentDetailView.vue. CodeQL's first scan of the
// hub (2026-09-16) flagged all three as incomplete URL sanitisation. As a
// security finding that is a false positive - nothing is trusted or fetched on
// the answer - but the substring was imprecise all the same:
// `ann+noreply.github.com@gmail.com` is a real mailbox it threw away. The rule
// is the DOMAIN, compared as a hostname: `noreply.github.com` or a subdomain of
// it, which only GitHub can issue.
//
// Isomorphic and dependency-free: the collector and the SPA both import it.

const NOREPLY_DOMAIN = "noreply.github.com";

/**
 * @param {unknown} address  anything; a git author email is free text
 * @returns {boolean} true only for an address at GitHub's noreply domain
 */
export function isGitHubNoreplyAddress(address) {
  const s = String(address ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return false;
  const domain = s.slice(at + 1);
  return domain === NOREPLY_DOMAIN || domain.endsWith(`.${NOREPLY_DOMAIN}`);
}
