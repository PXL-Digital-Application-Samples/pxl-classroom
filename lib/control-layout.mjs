// PXL Classroom — the control repo directory layout (ARCHITECTURE.md §5.1).
//
// One source of truth, consumed by:
//   - lib/audit.mjs             (re-exported; drives the scaffold-intact check)
//   - scripts/scaffold-control-repo.mjs  (used by setup-org.yml)
//   - control-repo-template/    (asserted equal by tests/scaffold.test.mjs)
//
// Deliberately dependency-free: setup-org.yml runs the scaffold script without
// `npm ci`, so anything imported here must not pull in node_modules.

export const CONTROL_SCAFFOLD_DIRS = Object.freeze([
  "assignments",
  "students",
  "acceptances",
  "repositories",
  "observations",
  "lockdowns",
  "reports",
  "overrides",
  "errors",
  "public",
]);
