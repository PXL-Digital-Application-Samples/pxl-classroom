// Automated checks: the rules the form, the modal and the tests all share.
//
// Pure on purpose - no Vue, no fetch - so `tests/autograde-modal.test.mjs` can
// run the real presets through the real schema instead of asserting that some
// string appears in a template. The Admin Panel used to hold all of this inline
// in a row editor whose only guard was the schema, three commits downstream
// (UX_PLAN §6).

/**
 * Named starting points, each pre-filled with something that actually runs.
 *
 * "Add a row, now pick a type from a dropdown, now work out which fields that
 * type wants" is a config language. A lecturer picking "compare output for
 * given input" has already said everything the row needs.
 */
export const CHECK_PRESETS = [
  {
    key: 'run',
    label: 'A command that must succeed',
    hint: 'Passes when the command exits 0.',
    baseId: 'builds',
    make: () => ({ type: 'run', command: 'make test', points: 10 }),
  },
  {
    key: 'io',
    label: 'Compare output for given input',
    hint: 'Feeds stdin to a command and compares stdout, trimmed.',
    baseId: 'output',
    make: () => ({
      type: 'io',
      command: './greet',
      stdin: 'Alice\n',
      expected_stdout: 'Hello Alice\n',
      points: 10,
    }),
  },
  {
    key: 'python',
    label: 'A Python script',
    hint: 'Runs the script; a failed assert fails the check.',
    baseId: 'script',
    make: () => ({
      type: 'python',
      script: 'import subprocess\nassert subprocess.run(["./solution"]).returncode == 0\n',
      points: 10,
    }),
  },
]

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** `builds`, then `builds-2`, then `builds-3`. Ids have to be unique. */
function uniqueId(base, taken) {
  const used = new Set(taken.map((t) => String(t?.id || '').trim()))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

export function newCheck(presetKey, existing = []) {
  const preset = CHECK_PRESETS.find((p) => p.key === presetKey)
  if (!preset) return null
  return { id: uniqueId(preset.baseId, existing), ...preset.make() }
}

/**
 * Why this row cannot be saved, or null.
 *
 * The schema says the same things, but it says them as
 * `/autograde/tests/2/id must match pattern "^[a-z0-9]..."` after Save, and
 * `cleanChecks` would have written `id: ''` for an untouched row so the failure
 * lands on the pattern rather than on "you left it blank" (UX_PLAN §6.3).
 */
export function checkProblem(check) {
  const id = String(check?.id ?? '').trim()
  if (!id) return 'Give this check an ID.'
  if (!ID_PATTERN.test(id)) return 'The ID must be lowercase letters, numbers and dashes.'

  const points = Number(check?.points)
  if (!Number.isFinite(points) || points < 0) return 'Points must be a number, 0 or more.'

  if (check.type === 'python') {
    if (!String(check.script ?? '').trim()) return 'A Python check needs a script - it is the only thing it runs.'
    return null
  }
  if (!String(check.command ?? '').trim()) return 'Give this check a command to run.'
  if (check.type === 'io' && !String(check.expected_stdout ?? '').trim()) {
    return 'Say what output to expect.'
  }
  return null
}

/** Per-row problems, including duplicate ids - which collide in the workflow. */
export function checkProblems(checks) {
  const list = Array.isArray(checks) ? checks : []
  const counts = new Map()
  for (const c of list) {
    const id = String(c?.id ?? '').trim()
    if (id) counts.set(id, (counts.get(id) || 0) + 1)
  }
  return list.map((c) => {
    const own = checkProblem(c)
    if (own) return own
    if (counts.get(String(c.id).trim()) > 1) return 'Two checks share this ID.'
    return null
  })
}

/** Total points, which is the number a lecturer actually cares about. */
export function totalPoints(checks) {
  return (Array.isArray(checks) ? checks : []).reduce((sum, c) => {
    const n = Number(c?.points)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)
}

/**
 * The schema shape. Only the fields the type uses, because the test item is
 * `additionalProperties: false` - a leftover `command` on a python check is a
 * document the schema rejects, and used to be a field the generator preferred.
 */
export function cleanChecks(checks) {
  return (Array.isArray(checks) ? checks : []).map((t) => ({
    id: String(t.id ?? '').trim(),
    type: t.type || 'run',
    points: Number(t.points) || 0,
    ...(t.type === 'python'
      ? { ...(t.script ? { script: t.script } : {}) }
      : { ...(t.command ? { command: t.command } : {}) }),
    ...(t.type === 'io' && t.stdin ? { stdin: t.stdin } : {}),
    ...(t.type === 'io' && t.expected_stdout ? { expected_stdout: t.expected_stdout } : {}),
    ...(t.timeout_s ? { timeout_s: Number(t.timeout_s) } : {}),
  }))
}

/**
 * The one line the assignment form shows. The configuration's existence is the
 * flag, so there is no separate "enabled" checkbox to disagree with it.
 */
export function summariseAutograde({ enabled, execution_environment: env, visibility, tests } = {}) {
  const count = Array.isArray(tests) ? tests.length : 0
  if (!enabled || count === 0) return 'Off'
  const checks = `${count} check${count === 1 ? '' : 's'}`
  if (env === 'github_actions') {
    return `${checks} · run in student repos, ${visibility === 'public' ? 'visible' : 'hidden'}`
  }
  return `${checks} · run on your machine`
}
