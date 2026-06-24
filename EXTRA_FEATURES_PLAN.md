# Extra Features Plan

Implementation plan for the 8 enhancements derived from the classroom50 review. Each feature had a CLI design, a UI equivalent where the lecturer workflow benefits from one, and concrete file/schema touchpoints.

This is a planning artifact, not a runtime spec. When a feature ships, its design folds into `ARCHITECTURE.md` / `RUNBOOK.md` and the entry here is trimmed. **This file shrinks monotonically.**

---

## Status

| Phase | # | Feature | State |
|---|---|---|---|
| A | 1 | `lib/gittree.mjs` commit primitive | **shipped** — see ARCHITECTURE §10.5 |
| A | 2 | `pxl-classroom` CLI + device-flow auth | **shipped** — see RUNBOOK §12 |
| A | 3 | CSV roster import (CLI + UI) | **shipped** — see RUNBOOK §12.4 |
| B | 4 | Submit-tag convention | **shipped** — see ARCHITECTURE §11.1a, RUNBOOK §12.6 |
| B | 5 | `audit` command | **shipped** — see ARCHITECTURE §12, RUNBOOK §12.5 |
| C | 6 | Feedback-PR pattern | **shipped** — see ARCHITECTURE §11.4, RUNBOOK §12.7 |
| C | 7 | Bulk submission download | **shipped** — see ARCHITECTURE §11.5, RUNBOOK §12.8 |
| C | 8 | Lecturer-side autograder | **shipped** — see ARCHITECTURE §11.6, RUNBOOK §12.9 |

All eight enhancements are now in the canonical docs. This file can be deleted on the next docs sweep; it remains only as a historical pointer until the next person reads it.
