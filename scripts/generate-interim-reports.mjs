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
          }
        }
      } catch (e) {
        console.error(`Error generating report for ${file}:`, e.message);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
