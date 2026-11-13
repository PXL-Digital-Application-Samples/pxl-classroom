// sync-starter-code.yml - a sync that reaches its time limit continues by
// itself, each round on its own App token.
//
// An installation token lives one hour. A lab of 18 MiB per student needed
// four runs by hand for 145 students (2026-11-13), each stopped at its budget
// and started again by a lecturer pressing Sync again. The job now does that
// itself: a round says whether students are left (`continues`), and the next
// one mints a fresh token and runs the same script.
//
// Everything here is read out of the two files, never spelled twice: the
// output's name comes from the script, the budget from the script, the rounds
// from the steps. A step output spelled wrong is the empty string, the `if:`
// is false, the run is green and the round never happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const script = read("scripts/sync-starter.mjs");
const job = parseYaml(read(".github/workflows/sync-starter-code.yml")).jobs["sync-starter"];
const steps = job.steps;

const isSync = (s) => typeof s.run === "string" && /node scripts\/sync-starter\.mjs/.test(s.run);
const isMint = (s) => typeof s.uses === "string" && s.uses.startsWith("actions/create-github-app-token@");
const isControlCheckout = (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@") && s.with?.path === "control";
const tokenOf = (expr) => String(expr || "").match(/^\$\{\{ steps\.(\w+)\.outputs\.token \}\}$/)?.[1];

const rounds = steps.map((s, i) => ({ s, i })).filter(({ s }) => isSync(s));

// The script's own name for its output.
const outputs = [...script.matchAll(/await setOutput\("(\w+)"/g)].map((m) => m[1]);

test("the script writes one output, and it is the one every later round waits on", () => {
  assert.deepEqual(outputs, ["continues"]);
  for (const s of steps) {
    for (const m of String(s.if || "").matchAll(/steps\.(\w+)\.outputs\.(\w+)/g)) {
      assert.equal(m[2], outputs[0], `${s.name}: waits on an output the script does not write`);
      assert.ok(rounds.some(({ s: r }) => r.id === m[1]), `${s.name}: waits on ${m[1]}, which is not a sync step`);
    }
  }
});

test("the rounds are numbered in order and each knows how many there are", () => {
  assert.ok(rounds.length >= 2, "a sync that cannot continue is the thing this replaced");
  for (const [n, { s }] of rounds.entries()) {
    assert.equal(s.env.SYNC_ROUND, String(n + 1), s.name);
    assert.equal(s.env.SYNC_ROUNDS, String(rounds.length), s.name);
    assert.ok(s.id, `${s.name}: the next round reads its output by id`);
  }
});

test("every round after the first runs only when the round before it said students are left", () => {
  for (const [n, { s }] of rounds.entries()) {
    if (n === 0) {
      assert.equal(s.if, undefined, "the first round is the sync");
      continue;
    }
    assert.equal(s.if, `steps.${rounds[n - 1].s.id}.outputs.${outputs[0]} == 'true'`, s.name);
  }
});

test("every round has a token minted for it and a control checkout made with it, after the round before", () => {
  const seen = new Set();
  for (const [n, { s, i }] of rounds.entries()) {
    const from = n === 0 ? 0 : rounds[n - 1].i + 1;
    const own = steps.slice(from, i);
    const tokenId = tokenOf(s.env.GITHUB_TOKEN);
    assert.ok(tokenId, `${s.name}: its token is a step's output`);
    assert.equal(seen.has(tokenId), false, `${s.name}: reuses the token of an earlier round, which is the one that expires`);
    seen.add(tokenId);
    const mint = own.find((x) => isMint(x) && x.id === tokenId);
    assert.ok(mint, `${s.name}: ${tokenId} is not minted between the round before and this one`);
    assert.equal(mint.if, s.if, `${s.name}: its token is minted on another condition than it runs on`);
    const checkout = own.find(isControlCheckout);
    assert.ok(checkout, `${s.name}: the control repository is not checked out again for it`);
    assert.equal(tokenOf(checkout.with.token), tokenId, `${s.name}: the checkout stores another round's token`);
    assert.equal(checkout.if, s.if);
    assert.ok(own.indexOf(mint) < own.indexOf(checkout));
    // Same inputs every round: only the token and the round number differ.
    const { GITHUB_TOKEN: _t, SYNC_ROUND: _r, ...rest } = s.env;
    const { GITHUB_TOKEN: _t0, SYNC_ROUND: _r0, ...first } = rounds[0].s.env;
    assert.deepEqual(rest, first, s.name);
  }
});

test("a round ends inside its token's hour: budget < step limit < 60, and the job allows every round", () => {
  const budget = script.match(/\|\| (\d+) \* 60_000,/);
  assert.ok(budget, "the budget is spelled as minutes times 60_000");
  const minutes = Number(budget[1]);
  for (const { s } of rounds) {
    assert.ok(s["timeout-minutes"] < 60, `${s.name}: may outlive its token`);
    // Room for the student it is in the middle of and the final record.
    assert.ok(s["timeout-minutes"] - minutes >= 5, `${s.name}: ${minutes} minutes of budget under a limit of ${s["timeout-minutes"]}`);
  }
  assert.ok(job["timeout-minutes"] >= rounds.length * 60, "the job would end a round the steps allow");
});
