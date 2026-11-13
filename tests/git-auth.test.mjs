// lib/git-auth.mjs - a git command authenticated with the App token asks
// NOBODY for a password when the server refuses it.
//
// GIT_TERMINAL_PROMPT=0 turns off the terminal only. Git asks an askpass
// program first - GIT_ASKPASS, then core.askPass, then SSH_ASKPASS - and Git
// Bash on Windows sets SSH_ASKPASS to one that opens a window: on 2026-11-13
// the suite, run from Git Bash, put "Password for 'http://...@127.0.0.1:52395'"
// on the screen of the person running it and waited for an answer. The 401
// clone of tests/provision-full-history.test.mjs (F9) is the behaviour; this
// pins the three settings it depends on, since F9 only shows the window on a
// machine that offers an askpass program.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitAuthEnv } from "../lib/git-auth.mjs";

test("gitAuthEnv empties every askpass git would run, and both prompts", () => {
  const env = gitAuthEnv("token", "http://127.0.0.1:1234");
  // An empty value is no program; an absent one lets the next in line answer.
  assert.equal(env.GIT_ASKPASS, "");
  assert.equal(env.SSH_ASKPASS, "");
  const config = new Map();
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) config.set(env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]);
  assert.equal(config.size, Number(env.GIT_CONFIG_COUNT), "every counted key is set, none twice");
  assert.equal(config.get("core.askPass"), "");
  assert.equal(config.get("credential.helper"), "");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GCM_INTERACTIVE, "never");
  assert.match(config.get("http.http://127.0.0.1:1234/.extraheader"), /^AUTHORIZATION: basic /);
});
