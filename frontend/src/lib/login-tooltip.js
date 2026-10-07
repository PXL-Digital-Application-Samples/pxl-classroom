// What hovering a student's login says, on the Progress and Grading tabs.
//
// The login opens the student's repository (asked 2026-10-07), so its tooltip
// says what a lecturer looks for before opening it: on Progress the last
// commit, on Grading the commit the score was read from. Everything comes from
// the rows already on screen - no request per hover.
//
// What it does NOT say is as deliberate as what it does (DESIGN.md §1.5):
//   - a commit's time is its OWN timestamp, never when the collector looked
//     (`latest_observed_at`) - observation time can only err late, and against
//     exactly the students who work up to the deadline (CLAUDE.md);
//   - a graded hand-in is shown at when GitHub recorded its push, the time its
//     lateness was judged by (lib/submission-marker.mjs `handInShownTime`), and
//     any other graded commit at its own timestamp - each line says which, as
//     "pushed" or "committed";
//   - the graded commit's line says how that time relates to the deadline as a
//     fact ("2h before"), never "on time": that is the grader's verdict, made
//     against the deadline of the day it graded;
//   - absent is said as absent ("No commits yet") only where the row says so,
//     and otherwise left out - unknown is not none.
//
// Pure: values in, text out, so a test runs it rather than describes it.

import { countdownParts } from './countdown.js'
import { handInShownTime, PUSH_TO_RUN_ALLOWANCE_MS } from '../../../lib/submission-marker.mjs'

/** The first line of a commit message, shortened for one tooltip line. */
export function commitHeadline(message, max = 72) {
  if (typeof message !== 'string') return ''
  const first = message.split(/\r?\n/).find((line) => line.trim()) || ''
  const line = first.trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** "2h 3m before the deadline" / "1d 4h after the deadline", or '' when either is unknown. */
export function relationToDeadline(at, deadline) {
  if (!at || !deadline) return ''
  const deadlineAt = new Date(deadline)
  if (Number.isNaN(deadlineAt.getTime())) return ''
  // countdownParts(at, now) measures `at` from `now`: with the deadline as
  // `now`, `passed` means the commit is at or before it.
  const span = countdownParts(at, deadlineAt)
  if (!span) return ''
  // Minutes are rounded down, so "0m" would be the answer for anything up to
  // a minute either side - exactly where a lecturer reads closely.
  const diff = span.at.getTime() - deadlineAt.getTime()
  if (diff === 0) return 'exactly at the deadline'
  if (Math.abs(diff) < 60_000) return `less than a minute ${diff < 0 ? 'before' : 'after'} the deadline`
  return span.passed ? `${span.duration} before the deadline` : `${span.duration} after the deadline`
}

const short = (sha) => String(sha).slice(0, 7)

/** "45s" / "1m 30s": the allowance is two minutes, so seconds are the unit. */
function seconds(msDiff) {
  const s = Math.round(msDiff / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`
}

/**
 * When the graded commit was made, against the deadline. A hand-in at its
 * push, which is what its lateness was judged by; any other commit at its own
 * timestamp. Each says which.
 */
function gradedWhen({ committedAt, pushedAt, pushedFrom, deadline }, fmt) {
  const shown = pushedAt ? handInShownTime({ pushedAt, pushedFrom }, deadline) : null
  if (shown) {
    if (shown.allowance) {
      // GitHub started the grading run after the deadline, inside the margin
      // the rule gives for its own delay: counted as on time, and "1m after
      // the deadline" alone would say the opposite of the grade beside it.
      const late = seconds(Date.parse(shown.at) - Date.parse(deadline))
      const margin = PUSH_TO_RUN_ALLOWANCE_MS / 60_000
      return `, pushed ${fmt(shown.at)} (GitHub started its run ${late} after the deadline, within the ${margin} minutes allowed for its own delay)`
    }
    const relation = relationToDeadline(shown.at, deadline)
    return `, pushed ${fmt(shown.at)}${relation ? ` (${relation})` : ''}`
  }
  if (!committedAt) return ''
  const relation = relationToDeadline(committedAt, deadline)
  return `, committed ${fmt(committedAt)}${relation ? ` (${relation})` : ''}`
}

/**
 * The Progress tab's login tooltip.
 *
 * @param {object} row
 * @param {string|null} [row.who]            who the student is (the page's studentTooltip)
 * @param {boolean} row.hasRepo
 * @param {string|null} [row.sha]            the newest commit seen
 * @param {string|null} [row.committedAt]    that commit's OWN timestamp
 * @param {string|null} [row.message]
 * @param {number|null} [row.commitCount]
 * @param {string} [row.deadlineSentence]    describeSubmission(...) for the row
 * @param {(iso: string) => string} fmt
 */
export function progressLoginTitle({ who, hasRepo, sha, committedAt, message, commitCount, deadlineSentence }, fmt) {
  const lines = []
  if (who) lines.push(who)
  if (!hasRepo) {
    lines.push('No repository yet.')
  } else if (sha) {
    const headline = commitHeadline(message)
    lines.push(
      `Last commit ${short(sha)}${committedAt ? `, ${fmt(committedAt)}` : ''}${headline ? `: ${headline}` : ''}`,
    )
    if (deadlineSentence) lines.push(deadlineSentence)
  } else if (commitCount === 0) {
    lines.push('No commits yet.')
  }
  return lines.join('\n') || null
}

/**
 * The Grading tab's login tooltip.
 *
 * @param {object} row
 * @param {string|null} [row.who]
 * @param {string|null} [row.sha]          the graded commit
 * @param {string|null} [row.committedAt]  its OWN timestamp, where the report knows it
 * @param {string|null} [row.pushedAt]     a hand-in's push, as the grading summary recorded it
 * @param {"run"|"log"|null} [row.pushedFrom]
 * @param {string|null} [row.deadline]     this student's effective deadline
 * @param {{graded_number?: number|null, allowed?: number}|null} [row.handIns]
 * @param {{kind: string, by: string}|null} [row.decidedBy]
 * @param {(iso: string) => string} fmt
 */
export function gradingLoginTitle({ who, sha, committedAt, pushedAt, pushedFrom, deadline, handIns, decidedBy }, fmt) {
  const lines = []
  if (who) lines.push(who)
  if (decidedBy?.kind === 'score') {
    lines.push(`Score set by hand by @${decidedBy.by}; no commit was graded.`)
  } else if (sha) {
    lines.push(`Graded commit ${short(sha)}${gradedWhen({ committedAt, pushedAt, pushedFrom, deadline }, fmt)}`)
    if (decidedBy?.kind === 'commit') lines.push(`Chosen by @${decidedBy.by}, not by the rules.`)
    if (Number.isInteger(handIns?.graded_number)) {
      lines.push(`Hand-in ${handIns.graded_number} of the ${handIns.allowed} allowed.`)
    }
  } else {
    lines.push('No graded commit recorded.')
  }
  return lines.join('\n')
}
