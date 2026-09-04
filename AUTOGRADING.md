# Autograding

For lecturers. How to get a score per student, and what to do when there isn't one.

Everything here is behind one field in the assignment editor: **Autograding** → **Set up**.

---

## Which case are you in

| Your situation | Pick |
| :--- | :--- |
| Template came from GitHub Classroom and already has `classroom.yml` | They come with my template → On every push |
| Exam. The checks talk to the student's own cloud account | They come with my template → Only on a hand-in commit |
| Template has no grading workflow and you want one | They come with my template → **Add a starter workflow** |
| You want checks students cannot read, or a score per check | I define them here |
| No automatic scoring | Leave it Off |

---

## 1. Template already grades

The usual case. Your template has a workflow with `classroom-resources/autograding-grading-reporter` in it, and PXL Classroom leaves it alone.

1. **Autograding → Set up**.
2. **They come with my template**, then **On every push**.
3. Save.

Nothing else to configure. You do not re-enter the exercises or their points; the workflow reports both.

After the deadline, read the scores (below).

## 2. Exam: grade only the hand-in commit

Use this when the checks cannot be re-run later — they read the student's own AWS or Azure account, and that account is gone when the lab session ends. The score has to be taken while the student is still working.

Your template's workflow needs the gate:

```yaml
if: github.event.head_commit.message == 'einde examen'
```

Then:

1. **They come with my template** → **Only on a hand-in commit**.
2. Type the same words in **Commit message**. Matched exactly. `Einde examen` and `einde examen!` do not count.
3. **They may hand in more than once** is on. The last hand-in before the deadline is graded, so a student who fixes something and hands in again is graded on the fix. Turn it off and the first one counts.

Tell students the exact words to type.

What this changes: the score is read from the hand-in commit, not from their last commit. Pushing something afterwards does not lose the score and does not replace it.

A hand-in after the deadline is never graded. That student appears by name with the time they did it, so you can decide what to do.

## 3. Template does not grade yet

The panel reads your template and says what it grades on. If it finds no grading workflow:

1. Type the hand-in message first, if you want one — it is written into the file.
2. **Add a starter workflow**. This commits `.github/workflows/classroom.yml` to your template repository.
3. Open that file and replace the `example` step with your own checks.

The example check **fails on purpose** until you replace it. A placeholder that passed would hand out full marks for work nobody measured.

Each check needs three things that must match, or its points go missing with no error:

* the step's `id`
* `<ID>_RESULTS` in the reporter's `env:`
* the same `id` in the reporter's `runners:`

**Students who already accepted do not get the file.** Writing to the template does not touch their repositories. Run **··· More → Sync Starter Code** on the assignment; the new file lands on their `main` without a pull request.

If your template already has a `classroom.yml` that does not grade, the button refuses rather than overwriting it.

## 4. You write the checks in PXL Classroom

For checks students must not see, or grading you run yourself after the deadline against the archived submission. This is also the only way to get a score per check instead of one total.

1. **I define them here**.
2. **Where do they run?**
   * *On your machine* — no Actions minutes, checks never reach the student repository, you run the CLI after the deadline.
   * *In each student's repo* — runs on every push on the organisation's Actions minutes, student sees a pass/fail each time.
3. If in student repos: **Can students read the checks?** *No* keeps them in the control repository.
4. Add checks. Three starting points, each pre-filled: a command that must succeed, compare output for given input, a Python script.

A blank points box is not zero. If a check is worth nothing, type `0`.

For *on your machine*, grade after the deadline:

```bash
pxl-classroom grade --org <org> --assignment <assignment-id> --runner docker
```

## 5. No autograding

Leave it Off. Everything else about the assignment works normally.

---

## Reading the scores

**··· More → Read scores from GitHub Actions**. Once grades are on screen, the same action sits in the Autograder panel.

The Score and CI columns fill in, and the CSV export carries them.

Scores are advisory. Nothing is graded for you.

There is no per-check breakdown on this path. The workflow reports one total, and the drill-down links to the run. For a breakdown, use case 4 with `--runner docker`.

## When a student has no score

They are listed by name in the Autograder panel with the reason. They are **not** scored zero — nothing ran, so nothing was measured.

| What it says | What happened |
| :--- | :--- |
| the grading workflow was skipped at `abc1234` | The workflow did not run on that commit. With a hand-in message set, they never handed in with those exact words. |
| the only "einde examen" commit is after the deadline | They handed in late. The time is in the message. |
| no commit says "einde examen" | They never handed in. |
| no autograding run at commit `abc1234` | No workflow produced a grading check run there. Check the template still has one, and that the student did not delete it. |
| could not read the score annotations | The run exists, its results could not be read. Try again; if it persists, open the run. |

## Things that go wrong

**Every student reads 0.** Check the reporter's `runners:` and `env:` against the step ids. A step missing from either contributes nothing and reports no error.

**The panel warns that your template grades on different words.** Your workflow and the assignment disagree. The workflow's wording is the one that decides, because it is what the runner compares. **Use the template's wording** copies it into the assignment. The file is never rewritten for you.

**A Node 20 warning on every result.** Your workflow uses `actions/checkout@v4`. Change it to `@v7`.

**The `setup env` step fails on a re-run.** `mkdir ~/.aws` fails when the directory exists. Use `mkdir -p ~/.aws`.

**GitHub refuses to show CI results.** The PXL Classroom App needs the *Checks* permission. An owner of the organisation approves it under Settings → GitHub Apps.

**A `python` check runs but tests nothing.** A python check is its `script`, and the interpreter runs it. A file that only defines `def test_x()` passes without testing. Write the assertions directly, or use a command check with `pytest`.
