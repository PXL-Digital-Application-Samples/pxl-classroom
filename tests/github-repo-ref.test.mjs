// What a lecturer actually has on the clipboard when they fill in Template
// repository, and what the field must make of it.
//
// The function is IMPORTED, not restated. A table of inputs checked against a
// regex written in this file would be two parsers agreeing with each other.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRepoRef } from '../frontend/src/lib/github-repo-ref.js'

const ORG = 'PXL-SNE-AutomationAndScripting2627'
const REPO = 'ps-02-ext_lab'
const FULL = `${ORG}/${REPO}`

test('the reported case: the address bar, pasted whole', () => {
  assert.equal(normalizeRepoRef(`https://github.com/${FULL}`), FULL)
})

test('the shapes a browser or a clone dialog hands over', () => {
  for (const [input, expected] of [
    [`http://github.com/${FULL}`, FULL],
    [`https://www.github.com/${FULL}`, FULL],
    [`github.com/${FULL}`, FULL],
    [`https://github.com/${FULL}.git`, FULL],
    [`https://github.com/${FULL}/`, FULL],
    [`git@github.com:${FULL}.git`, FULL],
    [`ssh://git@github.com/${FULL}.git`, FULL],
    // The likeliest paste of all: GitHub's own "Use this template" button.
    [`https://github.com/${FULL}/generate`, FULL],
    [`https://github.com/${FULL}/tree/main`, FULL],
    [`https://github.com/${FULL}/settings`, FULL],
    [`https://github.com/${FULL}?tab=readme-ov-file`, FULL],
    [`https://github.com/${FULL}#readme`, FULL],
    [`  https://github.com/${FULL}  `, FULL],
    // Case is preserved: an owner is compared lowercased elsewhere, but what
    // goes in the document is what GitHub spells it as.
    ['PXL-Digital-Application-Samples/Some.Repo_v2', 'PXL-Digital-Application-Samples/Some.Repo_v2'],
  ]) {
    assert.equal(normalizeRepoRef(input), expected, input)
  }
})

test('a value that is already the full name comes back unchanged, whitespace tidied', () => {
  assert.equal(normalizeRepoRef(FULL), FULL)
  assert.equal(normalizeRepoRef(`   ${FULL}   `), FULL)
})

test('null for anything it cannot read, so the field keeps what was typed', () => {
  for (const input of [
    '',
    '   ',
    null,
    undefined,
    42,
    ORG,
    'not a url at all',
    `${ORG}/${REPO}/extra`, // three segments are ambiguous, not a repository
    'https://github.com/one-segment-only',
    'https://github.com/',
  ]) {
    assert.equal(normalizeRepoRef(input), null, JSON.stringify(input))
  }
})

test('a non-GitHub host is refused rather than normalised into a repository that cannot exist', () => {
  // DESIGN.md §1.5: `a/b` here would look valid and be unreachable. The field's
  // own error is the honest answer.
  for (const input of [
    `https://gitlab.com/${FULL}`,
    `https://bitbucket.org/${FULL}`,
    `https://github.example.com/${FULL}`,
    `https://notgithub.com/${FULL}`,
    `git@gitlab.com:${FULL}.git`,
  ]) {
    assert.equal(normalizeRepoRef(input), null, input)
  }
})

test('typing a URL by hand converges instead of fighting the caret', () => {
  // The rewrite fires on input, so it has to be safe mid-word. It stays null
  // until both segments exist; from then on every keystroke lands on the
  // already-normalised value, which is why the caret never has to move.
  assert.equal(normalizeRepoRef('https://github.com/PXL'), null)
  assert.equal(normalizeRepoRef('https://github.com/PXL/'), null)
  assert.equal(normalizeRepoRef('https://github.com/PXL/p'), 'PXL/p')
  assert.equal(normalizeRepoRef('PXL/ps'), 'PXL/ps')
})

test('normalising is idempotent', () => {
  const once = normalizeRepoRef(`https://github.com/${FULL}/generate`)
  assert.equal(normalizeRepoRef(once), once)
})

test('AdminView replaces the box only when the value differs', () => {
  // The guard in onTemplateInput is `normalized && normalized !== text`. An
  // already-correct value must therefore come back EQUAL, not null, or every
  // keystroke would reassign the input and the caret would jump to the end
  // mid-edit.
  assert.equal(normalizeRepoRef(FULL), FULL)
})
