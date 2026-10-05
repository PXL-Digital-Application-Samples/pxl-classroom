// What a change on the Teams tab does to a student, said before and after it
// happens.
//
// The move confirmation used to be one sentence for every case: "Their access
// to the Alpha repository is revoked and they are granted access to the Bravo
// repository." On the testbed (2026-10-04) Bravo had no repository, the student
// had never accepted, and neither half was true. A lecturer moving a student
// mid-exam reads this to decide whether to warn them, so each sentence here is
// computed from the case in hand: whether the student accepted, and whether
// each team has a repository (`teamRepository`, the same test the record
// planner uses, so the text and the write cannot disagree).
//
// Facts the sentences rest on, all measured or read from the code:
//   * provisioning grants only the student who is accepting
//     (provisioning/provision.mjs, `cfg.studentLogin`), so a member of a team with no repository
//     gets one only by accepting - again, if they had accepted before;
//   * adding someone to a repository that exists sends an invitation
//     (lib/permission-change.mjs) that they must accept on GitHub;
//   * a student who never accepted has no access anywhere to take away.

import { teamRepository } from '../../../lib/team-member-records.mjs'

const repoShort = (repo) => String(repo.repo_name).split('/').pop()
const nameOf = (team) => team?.team_name || team?.team_slug || 'the team'

/**
 * The confirmation for moving `login` from one team to another.
 *
 * @param {object} args
 * @param {string} args.login
 * @param {object} args.from   the team row they leave
 * @param {object} args.to     the team row they join
 * @param {string} args.org
 * @param {boolean} args.accepted  whether they accepted (the table's own rule)
 * @param {boolean} args.draft     the assignment is a draft
 * @returns {{title: string, confirmLabel: string, destructive: boolean, paragraphs: string[]}}
 */
export function moveConfirmation({ login, from, to, org, accepted, draft }) {
  const who = `@${login}`
  const title = `Move ${who} to ${nameOf(to)}?`
  const confirmLabel = `Move ${who}`
  if (draft) {
    return {
      title,
      confirmLabel,
      destructive: false,
      paragraphs: [
        `${who} leaves ${nameOf(from)} and joins ${nameOf(to)}. The assignment is a draft, so nobody has a repository yet and no access changes.`,
      ],
    }
  }
  const fromRepo = teamRepository(from, org)
  const toRepo = teamRepository(to, org)
  const revokes = Boolean(accepted && fromRepo)
  const paragraphs = []

  if (revokes) paragraphs.push(`${who} loses access to ${repoShort(fromRepo)} now.`)
  else if (!accepted) paragraphs.push(`${who} has not accepted yet, so there is no access to remove.`)

  if (toRepo) {
    paragraphs.push(`They get an invitation to ${repoShort(toRepo)}, and can push there once they accept it on GitHub.`)
  } else if (accepted) {
    paragraphs.push(
      `${nameOf(to)} has no repository yet, so ${who} has no team repository until they open the invitation link and accept again.`,
    )
  } else {
    paragraphs.push(`${nameOf(to)} has no repository yet. ${who} gets access to it when they accept.`)
  }
  return { title, confirmLabel, destructive: revokes, paragraphs }
}

/**
 * The confirmation for deleting a team, which only an empty team can be.
 *
 * @param {object} team
 * @returns {{title: string, confirmLabel: string, destructive: boolean, paragraphs: string[]}}
 */
export function deleteConfirmation(team) {
  const name = nameOf(team)
  return {
    title: `Delete team ${name}?`,
    confirmLabel: 'Delete team',
    destructive: true,
    paragraphs: [`${name} has no members. It is removed from this assignment.`],
  }
}

/**
 * What a member line in Manage says about them, by the rule the table's dimmed
 * "not accepted yet" pills use. Null where that rule says nothing: on a draft
 * nobody can have accepted, and with no student data at all nothing is known.
 *
 * @param {{draft: boolean, known: boolean, accepted: boolean, teamHasRepo: boolean}} args
 * @returns {{tone: 'success'|'warning'|'neutral', text: string}|null}
 */
export function memberStatus({ draft, known, accepted, teamHasRepo }) {
  if (draft || !known) return null
  if (!accepted) return { tone: 'warning', text: 'has not accepted yet' }
  return teamHasRepo
    ? { tone: 'success', text: 'has the team repository' }
    : { tone: 'neutral', text: 'accepted, no repository yet' }
}

/**
 * How one collaborator removal ended.
 *
 * A 404 is "they were not a collaborator", which is the end we wanted. A 403
 * on a username that is not a GitHub account is the same - there was never
 * any access to remove - and GitHub answers it with "Resource not accessible
 * by integration", which reads exactly like this App missing a permission
 * (testbed, 2026-10-04). So a 403 is only a failure once the account is known
 * to exist, and `accountExists` is asked only then: true, false, or null for
 * "GitHub did not say", which stays a failure, because unreadable is not
 * evidence.
 *
 * @param {{ok?: boolean, status?: number}|null|undefined} res
 * @param {boolean|null} [accountExists]
 * @returns {'removed'|'not-an-account'|'failed'}
 */
export function revokeOutcome(res, accountExists = null) {
  if (res?.ok || res?.status === 404) return 'removed'
  if (res?.status === 403 && accountExists === false) return 'not-an-account'
  return 'failed'
}

/** The sentence for logins that are not GitHub accounts, or '' for none. */
export function notAnAccountNote(logins) {
  if (!logins.length) return ''
  const list = logins.map((l) => `@${l}`).join(', ')
  return logins.length === 1
    ? `${list} is not a GitHub account, so there was no access to remove.`
    : `${list} are not GitHub accounts, so there was no access to remove.`
}
