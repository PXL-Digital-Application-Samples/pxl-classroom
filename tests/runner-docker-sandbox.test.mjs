// The docker runner's argv IS the sandbox, and a missing flag is silent.
//
// `-i` was missing, which is not a sandbox property but a correctness one:
// without it docker never attaches stdin, so every `type: io` check was graded
// against EMPTY INPUT while the Node side believed it had supplied some.
// Measured against a live daemon on 2026-09-08:
//
//   printf 'Ada\n' | docker run --rm      … -> stdin reads ''
//   printf 'Ada\n' | docker run --rm -i   … -> stdin reads 'Ada\n'
//
// It fails quietly both ways. A check whose program ignores its input, or whose
// expected output happens to match the empty-input output, PASSES for a reason
// nobody measured - which is the same class of defect as a check run's
// conclusion being read as a score.
//
// Argv rather than a live container, so this runs in CI with no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dockerArgs } from "../cli/src/lib/runner-docker.mjs";

const argv = (over = {}) =>
  dockerArgs({ image: "debian:stable-slim", args: ["/bin/sh", "-c", "true"], mounts: ["/w:/workspace:ro"], ...over });

test("stdin is attached, or an io check grades the wrong output", () => {
  const a = argv();
  assert.ok(a.includes("-i"), "docker discards stdin without -i and reports no error");
  // Before the image, like every other flag - `docker run <flags> IMAGE CMD`.
  assert.ok(a.indexOf("-i") < a.indexOf("debian:stable-slim"));
});

test("the sandbox the module documents is the sandbox it asks for", () => {
  const a = argv().join(" ");
  for (const flag of [
    "--network=none",   // a test may not fetch dependencies or exfiltrate
    "--read-only",      // nor mutate the image
    "--memory=512m",
    "--pids-limit=256",
    "--rm",
    "--init",           // reap zombies, so --pids-limit means something
  ]) {
    assert.ok(a.includes(flag), `the docker runner no longer passes ${flag}`);
  }
  assert.match(a, /--tmpfs \/tmp:rw,size=64m/, "somewhere writable, bounded");
});

test("the student's checkout is mounted READ-ONLY", () => {
  // "a buggy or malicious test cannot mutate the lecturer's filesystem" is the
  // module's own claim, and `:ro` is the whole of it.
  const a = argv({ mounts: ["/tmp/work:/workspace:ro"] });
  const i = a.indexOf("-v");
  assert.ok(i > -1, "the checkout has to be mounted");
  assert.match(a[i + 1], /:ro$/, "a writable mount would let a test edit the work it is grading");
});

test("the command runs after the image, and the image is never a flag", () => {
  const a = dockerArgs({ image: "python:3.12-slim", args: ["python3", "/t.py"], mounts: [] });
  assert.deepEqual(a.slice(-3), ["python:3.12-slim", "python3", "/t.py"]);
  assert.ok(!a.slice(0, a.indexOf("python:3.12-slim")).includes("python3"));
});
