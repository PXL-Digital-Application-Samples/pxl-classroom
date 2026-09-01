import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadYaml } from "../lib/yaml.mjs";

async function main() {
  const dataDir = process.argv[2] || "control";
  const assignmentsDir = path.join(dataDir, "assignments");

  if (!fs.existsSync(assignmentsDir)) {
    console.log("No assignments directory found at", assignmentsDir);
    return;
  }

  const files = fs.readdirSync(assignmentsDir);
  let failed = 0;
  for (const file of files) {
    if (file.endsWith(".yml") || file.endsWith(".yaml")) {
      const id = file.replace(/\.(yml|yaml)$/, "");
      const filePath = path.join(assignmentsDir, file);
      try {
        const assignment = await loadYaml(filePath);
        if (assignment && (assignment.state === "published" || assignment.state === "closed")) {
          console.log(`Generating interim report for assignment ${id}...`);
          const res = spawnSync("node", ["report/report.mjs"], {
            env: {
              ...process.env,
              ASSIGNMENT_ID: id,
              DATA_DIR: dataDir,
              OUTPUT_FORMAT: "both"
            },
            stdio: "inherit"
          });
          if (res.status !== 0) {
            console.error(`Failed to generate report for ${id}`);
            failed++;
          }
        }
      } catch (e) {
        console.error(`Error generating report for ${file}:`, e.message);
        failed++;
      }
    }
  }

  // Non-zero on partial failure, for the reason open-feedback-prs.mjs states
  // beside the same decision: "A run that could not [do the work] for four
  // students out of forty is not a success, and a lecturer reading a green tick
  // would never go looking." A report that did not regenerate is a dashboard
  // quietly serving yesterday's numbers.
  //
  // `exitCode`, not `exit()`: the reports that DID generate are already on disk,
  // and the workflow's commit step is `if: always()` so they are still kept.
  if (failed > 0) {
    console.error(`${failed} report(s) could not be generated.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
