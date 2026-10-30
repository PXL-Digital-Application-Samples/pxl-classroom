// The runner image every workflow names, and the one being tried for the next
// move. Never `ubuntu-latest`: GitHub moves that label by itself, over weeks and
// per runner, so the same job runs on two systems during the move and a course
// changes under its exams with nothing changed here.
//
// A workflow cannot import this, so tests/runner-image.test.mjs holds them equal.
// Moving is a commit, after `runner-probe.yml` is green on the next one. The
// grading workflows provisioning writes use it too, and those stay in a student's
// repository as written.
export const RUNNER_IMAGE = "ubuntu-24.04";
export const NEXT_RUNNER_IMAGE = "ubuntu-26.04";
