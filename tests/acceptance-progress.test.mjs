// frontend/src/lib/acceptance-progress.js: which step a student's acceptance is
// at, from their own broker issue and the hub run named after it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANSWER_GRACE_MS,
  BROKER_SLOW_MS,
  RETRY_OFFER_MS,
  attemptProgress,
  attemptRunFromPage,
  findAttemptRun,
  hubRunsPath,
  issueStage,
  progressMessage,
  progressSteps,
} from '../frontend/src/lib/acceptance-progress.js'
import { HANDLED_TITLE_BY_PURPOSE, NOT_DELIVERED_TITLE_BY_PURPOSE, REJECTED_ISSUE_TITLE } from '../lib/broker-issue-titles.mjs'
import { acceptanceRunName } from '../lib/acceptance-run-name.mjs'

const SENT = 1_000_000_000_000
const at = (ms) => SENT + ms
const signed = 'pxl-accept:a1.AAAA.BBBB team:fullhouse'

test('the issue title says how far the broker got', () => {
  assert.equal(issueStage(signed), 'sent')
  assert.equal(issueStage(HANDLED_TITLE_BY_PURPOSE.accept), 'handed-over')
  assert.equal(issueStage(NOT_DELIVERED_TITLE_BY_PURPOSE.accept), 'not-delivered')
  assert.equal(issueStage(REJECTED_ISSUE_TITLE), 'link-refused')
  assert.equal(issueStage(undefined), null, 'an unread title says nothing')
  assert.equal(issueStage('Something else'), null)
})

test('every title the broker can write is understood', () => {
  for (const t of [...Object.values(HANDLED_TITLE_BY_PURPOSE), ...Object.values(NOT_DELIVERED_TITLE_BY_PURPOSE), REJECTED_ISSUE_TITLE]) {
    assert.notEqual(issueStage(t), null, t)
  }
})

test('the run is found by the name the hub gives it', () => {
  const name = acceptanceRunName('Org/broker-lab', 66)
  const runs = [
    { display_title: acceptanceRunName('Org/broker-lab', 65), status: 'completed', created_at: '2026-10-02T10:00:00Z' },
    { display_title: name, status: 'queued', created_at: '2026-10-02T10:01:00Z' },
    { display_title: name, status: 'in_progress', created_at: '2026-10-02T10:02:00Z' },
  ]
  assert.equal(findAttemptRun(runs, { org: 'Org', broker: 'broker-lab', issue: 66 }).status, 'in_progress', 'the newest, if it ran twice')
  assert.equal(findAttemptRun(runs, { org: 'Org', broker: 'broker-lab', issue: 67 }), null)
  assert.equal(findAttemptRun(null, { org: 'Org', broker: 'broker-lab', issue: 66 }), null)
})

test('ONE PAGE IS NOT THE LIST: "not listed" means "not started" only when the page is all of it', () => {
  // Review 2026-10-06: a busy exam start puts more than a page of acceptances
  // after the attempt; its run fell off, and the page waited half an hour.
  const attempt = { org: 'Org', broker: 'broker-lab', issue: 66 }
  const other = { display_title: acceptanceRunName('Org/broker-lab', 65), status: 'completed' }
  const mine = { display_title: acceptanceRunName('Org/broker-lab', 66), status: 'completed', conclusion: 'cancelled' }
  assert.deepEqual(attemptRunFromPage({ total_count: 1, workflow_runs: [other] }, attempt), { run: null, runsRead: true })
  assert.deepEqual(attemptRunFromPage({ total_count: 140, workflow_runs: [other] }, attempt), { run: null, runsRead: false })
  assert.deepEqual(attemptRunFromPage({ total_count: 140, workflow_runs: [other, mine] }, attempt), { run: mine, runsRead: true })
  assert.deepEqual(attemptRunFromPage({ workflow_runs: [other] }, attempt), { run: null, runsRead: true }, 'no count: as before')
  assert.deepEqual(attemptRunFromPage(null, attempt), { run: null, runsRead: false })
  // Unread, a handed-over attempt says nothing - never "waiting for GitHub".
  assert.equal(attemptProgress({ title: HANDLED_TITLE_BY_PURPOSE.accept, run: null, runsRead: false, sentAt: SENT, now: at(600_000) }).step, 'unknown')
})

test('a request the broker has not started yet: patience, then the offer', () => {
  assert.deepEqual(attemptProgress({ title: signed, sentAt: SENT, now: at(10_000) }), { step: 'starting', final: false, canRetry: false })
  assert.deepEqual(attemptProgress({ title: signed, sentAt: SENT, now: at(BROKER_SLOW_MS) }), { step: 'not-started', final: false, canRetry: false })
  assert.deepEqual(attemptProgress({ title: signed, sentAt: SENT, now: at(RETRY_OFFER_MS) }), { step: 'not-started', final: false, canRetry: true })
})

test('not delivered is final at once, a refused link is final with nothing to retry', () => {
  assert.deepEqual(attemptProgress({ title: NOT_DELIVERED_TITLE_BY_PURPOSE.accept, sentAt: SENT, now: at(5_000) }), { step: 'not-delivered', final: true, canRetry: true })
  assert.deepEqual(attemptProgress({ title: REJECTED_ISSUE_TITLE, sentAt: SENT, now: at(5_000) }), { step: 'link-refused', final: true, canRetry: false })
})

test('handed over: what GitHub says about the run decides', () => {
  const t = HANDLED_TITLE_BY_PURPOSE.accept
  const p = (run, ms = 30_000, runsRead = true) => attemptProgress({ title: t, run, runsRead, sentAt: SENT, now: at(ms) })

  // 2026-10-02: the run sat queued. Waiting is right; the offer comes later.
  assert.deepEqual(p({ status: 'queued' }), { step: 'queued', final: false, canRetry: false })
  assert.deepEqual(p({ status: 'pending' }, RETRY_OFFER_MS), { step: 'queued', final: false, canRetry: true })
  assert.deepEqual(p(null), { step: 'queued', final: false, canRetry: false }, 'listed nowhere yet is not started yet')
  assert.deepEqual(p({ status: 'in_progress' }, RETRY_OFFER_MS), { step: 'running', final: false, canRetry: false }, 'never offered while it runs')
  assert.deepEqual(p({ status: 'completed', conclusion: 'cancelled' }), { step: 'stopped', final: true, canRetry: true })
  assert.deepEqual(p({ status: 'completed', conclusion: 'failure' }), { step: 'stopped', final: true, canRetry: true })

  const done = new Date(at(20_000)).toISOString()
  assert.deepEqual(p({ status: 'completed', conclusion: 'success', updated_at: done }, 30_000).step, 'finishing')
  assert.deepEqual(
    p({ status: 'completed', conclusion: 'success', updated_at: done }, 20_000 + ANSWER_GRACE_MS),
    { step: 'no-answer', final: true, canRetry: true },
    'finished with no repository, invitation or label: did not go through',
  )
})

test('UNREADABLE IS NOT EVIDENCE: without a title or a run list, nothing is concluded', () => {
  assert.equal(attemptProgress({ title: undefined, run: null, runsRead: false, sentAt: SENT, now: at(20 * 60_000) }).step, 'unknown')
  assert.equal(
    attemptProgress({ title: HANDLED_TITLE_BY_PURPOSE.accept, run: null, runsRead: false, sentAt: SENT, now: at(20 * 60_000) }).step,
    'unknown',
    'a run list that could not be read does not mean no run exists',
  )
  // A run still speaks without a title (the issue read failed this tick).
  assert.equal(attemptProgress({ title: undefined, run: { status: 'completed', conclusion: 'cancelled' }, sentAt: SENT, now: at(1) }).step, 'stopped')
})

test('the three steps, and a message for every step that needs one', () => {
  assert.deepEqual(progressSteps('queued').map((s) => s.state), ['done', 'done', 'current'])
  assert.deepEqual(progressSteps('starting').map((s) => s.state), ['done', 'current', 'todo'])
  assert.deepEqual(progressSteps('not-delivered').map((s) => s.state), ['done', 'failed', 'todo'])
  assert.deepEqual(progressSteps('stopped').map((s) => s.state), ['done', 'done', 'failed'])
  assert.deepEqual(progressSteps('unknown'), [])
  for (const step of ['not-started', 'queued', 'running', 'not-delivered', 'stopped', 'no-answer', 'link-refused']) {
    assert.ok(progressMessage(step), step)
    assert.doesNotMatch(progressMessage(step), /[–—]/, 'no em or en dashes')
  }
  assert.equal(progressMessage('unknown'), null)
})

test('the run list is asked for this attempt only, from shortly before it', () => {
  const path = hubRunsPath({ owner: 'Hub', repo: 'pxl-classroom', sentAt: Date.parse('2026-10-02T10:22:06Z') })
  assert.match(path, /^\/repos\/Hub\/pxl-classroom\/actions\/workflows\/acceptance-handler\.yml\/runs\?/)
  assert.match(decodeURIComponent(path), /created=>=2026-10-02T10:20:06Z/)
  assert.match(path, /event=repository_dispatch/)
})
