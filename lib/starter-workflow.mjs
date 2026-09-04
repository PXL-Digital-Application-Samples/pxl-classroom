// PXL Classroom - the grading workflow a lecturer can have written into their
// TEMPLATE repository, and how to tell whether one is already there.
//
// This is the template's file, not the student's. Provisioning leaves a
// template-owned workflow alone (ARCHITECTURE §11.6), and Sync Starter Code
// delivers it to students who accepted before it existed - a file absent from
// both the template's old commit and the student's repository is a *clean add*
// (lib/starter-sync.mjs), so it lands on their `main` with no pull request.
// That is the whole reason this can be offered after an assignment is live.
//
// SERIALISED, NEVER CONCATENATED. A lecturer's hand-in message reaches the
// `if:` expression, and a message containing a quote would close the string
// early and produce a workflow that does not parse - in the template, and from
// there in every repository generated from it. `provisioning/provision.mjs`
// carries the same rule and the same reason.
//
// Isomorphic: the SPA bundles it through frontend/src/lib/starter-workflow.js
// and the tests import it under plain Node. `yaml` is a dependency of both.

import { Document, parse } from "yaml";

/** The workflow file this writes, and the one provisioning already looks for. */
export const STARTER_PATH = ".github/workflows/classroom.yml";

/**
 * Does this workflow grade?
 *
 * The reporter is the signal, not the filename. It is what turns a step's
 * result into the `Points X/Y` annotation the dashboard reads, so a workflow
 * carrying it is a grading workflow whatever it is called, and one without it
 * is not - however much it looks like tests.
 */
export function isGradingWorkflow(text) {
  return /classroom-resources\/autograding-grading-reporter/.test(String(text ?? ""));
}

/**
 * The commit message this workflow grades on, or NULL for "every push".
 *
 * Reads the parsed document rather than the raw text, so a quoted, folded or
 * commented `if:` is the same to it. `==` ONLY: the other gate in the wild is
 * GitHub Classroom's own `github.actor != 'github-classroom[bot]'`, which skips
 * the bot's initial commit and grades every human push - not a hand-in message,
 * and reading it as one would tell a lecturer their students must type
 * "github-classroom[bot]".
 */
export function readGateMessage(text) {
  let doc;
  try {
    doc = parse(String(text ?? ""));
  } catch {
    return null; // Not parseable is not a gate.
  }
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return null;

  for (const job of Object.values(jobs)) {
    const expr = typeof job?.if === "string" ? job.if : "";
    // Single-quoted, with `''` for a literal quote - the pair matched here is
    // the same escape `gateExpression` writes. A lazy `(.*?)` stopped at the
    // first quote and read `it's over` back as `it`, which is the shape of
    // every quoting bug in this repository.
    const single = expr.match(/github\.event\.head_commit\.message\s*==\s*'((?:[^']|'')*)'/);
    if (single) return single[1].replace(/''/g, "'").trim();

    // Double-quoted is legal in a GitHub expression too, and a lecturer may
    // have written the workflow by hand.
    const double = expr.match(/github\.event\.head_commit\.message\s*==\s*"([^"]*)"/);
    if (double) return double[1].trim();
  }
  return null;
}

/**
 * `github.event.head_commit.message == '<message>'`, with the message escaped.
 *
 * THIS IS A VALUE COMPOSED INTO AN EXPRESSION, which CLAUDE.md forbids for
 * `${{ }}` and for shell text, and the reason is the same one: the runner
 * parses this string, so a quote in it ends the literal early. `einde "examen":
 * it's over` produced `== 'einde "examen": it'` followed by `s over'`, an
 * expression the runner cannot evaluate - so the job never runs, in every
 * repository generated from the template, and the lecturer sees it on results
 * day.
 *
 * There is no way to avoid composing here: an expression has no `env:` to put a
 * value in. So it is escaped the way GitHub documents - a literal single quote
 * is written as two - and `readGateMessage` undoes exactly that.
 */
function gateExpression(message) {
  return `github.event.head_commit.message == '${String(message).replace(/'/g, "''")}'`;
}

/**
 * A grading workflow for a template that has none.
 *
 * ITS ONE CHECK FAILS ON PURPOSE. A skeleton whose example step exits 0 reports
 * full marks for work nobody measured, in every student repository, and the
 * lecturer finds out when a cohort is already graded - DESIGN.md §1.5's most
 * expensive shape. Red on the first run is a lecturer's reminder that the
 * placeholder is still a placeholder.
 *
 * @param {{ handInMessage?: string|null }} opts
 */
export function buildStarterWorkflow({ handInMessage = null } = {}) {
  const gate = String(handInMessage ?? "").trim();

  const job = {
    "runs-on": "ubuntu-latest",
    ...(gate ? { if: gateExpression(gate) } : {}),
    steps: [
      // Not v4: it runs on Node 20, which GitHub has deprecated, and every
      // grading result carries a warning annotation saying so. FLOATING major
      // rather than a pinned SHA, like the workflow provisioning writes: this
      // file is copied into a template and from there into every student
      // repository, none of which holds a credential beyond its own
      // GITHUB_TOKEN.
      { name: "Checkout code", uses: "actions/checkout@v7" },
      {
        name: "example",
        id: "example",
        uses: "classroom-resources/autograding-command-grader@v1",
        with: {
          "test-name": "example",
          command:
            'echo "Replace this check with your own - see .github/workflows/classroom.yml" >&2; exit 1',
          // MINUTES. Every classroom-resources grader documents it that way,
          // which is what made `timeout_s` seconds mean thirty minutes here.
          timeout: 1,
          "max-score": 10,
        },
      },
      {
        name: "Autograding Reporter",
        uses: "classroom-resources/autograding-grading-reporter@v1",
        env: { EXAMPLE_RESULTS: "${{ steps.example.outputs.result }}" },
        with: { runners: "example" },
      },
    ],
  };

  const doc = new Document({
    name: "Autograding Tests",
    on: { push: { branches: ["main"] } },
    permissions: { checks: "write", actions: "read", contents: "read" },
    // `run-autograding-tests` is the job key on purpose: the check run takes
    // its name, and the score reader picks the run whose name says it grades
    // (`lib/check-run-score.mjs`).
    jobs: { "run-autograding-tests": job },
  });

  doc.commentBefore = [
    " Grading for this assignment, written by PXL Classroom.",
    "",
    " REPLACE THE `example` STEP with the checks this exercise needs. It fails",
    " on purpose until you do - a placeholder that passes would report full",
    " marks for work nobody measured.",
    "",
    " Every grader step needs three things that must agree: its `id`, its",
    " `<ID>_RESULTS` entry in the reporter's `env:`, and its id in the",
    " reporter's `runners:`. Miss one and that step's points go missing from",
    " the total, with no error.",
    ...(gate
      ? [
          "",
          ` This grades only a commit whose message is exactly "${gate}".`,
          " The assignment carries the same words; change them in the Admin",
          " Panel and here together, or scores will read as missing.",
        ]
      : []),
  ].join("\n");

  // `lineWidth: 0` turns off folding. It only ever affects readability - a
  // folded plain scalar rejoins to the same string - but the lecturer is
  // expected to open this file and edit it, and a shell command wrapped across
  // two lines reads as a mistake somebody made.
  return doc.toString({ lineWidth: 0 });
}
