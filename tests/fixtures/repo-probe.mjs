// Start the repository probe stand-in for a test file, once.
//
// `acceptance/accept.mjs` asks GitHub one question - is the target repository
// name already taken, and is it frozen - and every test that drives accept.mjs
// therefore needs something to answer it. Without this they reach the real
// api.github.com, get a 401, and the script correctly refuses.
//
// Used at MODULE SCOPE with top-level await, not in a `before()` hook: the
// runner functions in these files are plain synchronous helpers that build an
// env object, so the base URL has to exist by the time the module body runs.
// The child is unref'd, so a finished test file does not keep the process
// alive waiting for it.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverScript = fileURLToPath(new URL("./repo-probe-server.mjs", import.meta.url));

/**
 * @returns {Promise<{baseUrl: string, env: object, setRepos: (repos: object) => void}>}
 */
export async function startRepoProbe() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-probe-"));
  const fixturePath = join(dir, "probe.json");
  // Start empty: nothing exists, which is what every test that is not about
  // this feature expects, so adding the probe changes no existing expectation.
  writeFileSync(fixturePath, JSON.stringify({ repos: {} }));

  const child = spawn("node", [serverScript], {
    env: { ...process.env, PROBE_FIXTURE: fixturePath },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const onEarlyExit = (code) => {
    throw new Error(`probe server exited early (${code})`);
  };
  const baseUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d;
      const line = buf.split("\n").find((l) => l.startsWith("ready "));
      if (line) {
        child.stdout.off("data", onData);
        resolve(line.slice("ready ".length).trim());
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    child.once("exit", onEarlyExit);
  });
  child.off("exit", onEarlyExit);

  // BOTH of these, and neither is optional.
  //
  // `unref()` alone does not let the test process exit: the piped stdout is a
  // separate libuv handle and it is still referenced, so the run hangs after the
  // last test with no output and no failure - which is exactly what it did.
  // Destroying the stream is what actually releases the parent.
  //
  // And an unref'd child is not a killed one. Without the exit hook every test
  // file would leave a listening node process behind on the machine.
  child.stdout.destroy();
  child.unref();
  process.on("exit", () => {
    try {
      child.kill();
    } catch {
      // Already gone. Nothing to do in an exit handler anyway.
    }
  });

  return {
    baseUrl,
    /** Spread into a spawned script's env so lib/gh.mjs talks to the stand-in. */
    env: { GITHUB_TOKEN: "stub-token", GITHUB_API_URL: baseUrl },
    /** Rewrite what exists. Re-read per request, so it takes effect at once. */
    setRepos(repos) {
      writeFileSync(fixturePath, JSON.stringify({ repos: repos || {} }));
    },
  };
}
