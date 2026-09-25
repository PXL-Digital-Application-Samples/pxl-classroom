// The Admin Panel's "existing repositories still have the old template"
// notice decides here: frontend/src/lib/template-change.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { templateChanged, templateChangeNotice } from "../frontend/src/lib/template-change.js";

const OLD = { owner: "PXL-Automation-II", repository: "2627-wrong", repository_id: 1 };
const NEW = { owner: "PXL-Automation-II", repository: "2627-aut2-pe1", repository_id: 2 };

test("a different repository is a change", () => {
  assert.equal(templateChanged(OLD, NEW), true);
});

test("the same repository is not, whatever the case of its name", () => {
  assert.equal(templateChanged(OLD, { ...OLD }), false);
  assert.equal(templateChanged(OLD, { ...OLD, owner: "pxl-automation-ii", repository: "2627-WRONG" }), false);
});

test("a RENAME is not a change: the pin says it is the same repository", () => {
  assert.equal(templateChanged(OLD, { ...OLD, repository: "2627-renamed" }), false);
});

test("the same name over a different id IS a change (deleted and recreated)", () => {
  assert.equal(templateChanged(OLD, { ...OLD, repository_id: 99 }), true);
});

test("without both pins, the name decides", () => {
  const { repository_id: _a, ...oldNoPin } = OLD;
  const { repository_id: _b, ...newNoPin } = NEW;
  assert.equal(templateChanged(oldNoPin, NEW), true);
  assert.equal(templateChanged(OLD, newNoPin), true);
  assert.equal(templateChanged(oldNoPin, { ...oldNoPin }), false);
});

test("a new assignment, or one with no template either side, changes nothing", () => {
  assert.equal(templateChanged(null, NEW), false);
  assert.equal(templateChanged(undefined, NEW), false);
  assert.equal(templateChanged(OLD, null), false);
  assert.equal(templateChanged({ owner: "", repository: "" }, NEW), false);
});

test("the notice: a change with students holding repositories names the count and the new template", () => {
  assert.deepEqual(templateChangeNotice({ before: OLD, after: NEW, repositoryCount: 3 }), {
    count: 3,
    template: "PXL-Automation-II/2627-aut2-pe1",
  });
  assert.deepEqual(templateChangeNotice({ before: OLD, after: NEW, repositoryCount: 1 }).count, 1);
});

test("nobody has accepted: nothing to say", () => {
  assert.equal(templateChangeNotice({ before: OLD, after: NEW, repositoryCount: 0 }), null);
});

test("records unreadable: still told, with no number it does not have", () => {
  assert.deepEqual(templateChangeNotice({ before: OLD, after: NEW, repositoryCount: null }), {
    count: null,
    template: "PXL-Automation-II/2627-aut2-pe1",
  });
});

test("no change: nothing, whatever the count", () => {
  assert.equal(templateChangeNotice({ before: OLD, after: { ...OLD }, repositoryCount: 40 }), null);
  assert.equal(templateChangeNotice({ before: null, after: NEW, repositoryCount: 40 }), null);
});
