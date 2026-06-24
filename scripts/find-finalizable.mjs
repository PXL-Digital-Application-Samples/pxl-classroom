import fs from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../lib/yaml.mjs';

async function main() {
  const controlDir = process.argv[2] || '.';
  const org = process.argv[3];
  const assignmentsDir = path.join(controlDir, 'assignments');
  const lockdownsDir = path.join(controlDir, 'lockdowns');
  const finalizable = [];
  
  if (fs.existsSync(assignmentsDir)) {
    const files = fs.readdirSync(assignmentsDir);
    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.json')) {
        const id = file.replace(/\.(yml|yaml|json)$/, '');
        try {
          const assignment = await loadYaml(path.join(assignmentsDir, file));
          if (!assignment || !assignment.deadline_at) continue;
          
          const deadline = new Date(assignment.deadline_at).getTime();
          const now = Date.now();
          // within the last 25 hours (one full cron interval + slack)
          const oneHourAgo = now - 25 * 60 * 60 * 1000;
          
          if (deadline <= now && deadline >= oneHourAgo) {
            // Check idempotency: lockdowns/<id>/lockdown-record.json
            const lockdownFile = path.join(lockdownsDir, id, 'lockdown-record.json');
            if (!fs.existsSync(lockdownFile)) {
              finalizable.push({ org, assignment_id: id });
            }
          }
        } catch (e) {
          console.error(`Error processing ${file}:`, e.message);
        }
      }
    }
  }
  
  // Find all active assignments (deadline in the future, or no deadline, and published)
  let activeCount = 0;
  if (fs.existsSync(assignmentsDir)) {
    const files = fs.readdirSync(assignmentsDir);
    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.json')) {
        try {
          const assignment = await loadYaml(path.join(assignmentsDir, file));
          if (assignment && assignment.state === 'published') {
            if (!assignment.deadline_at || new Date(assignment.deadline_at).getTime() > Date.now()) {
              activeCount++;
            }
          }
        } catch(e) {}
      }
    }
  }
  
  fs.writeFileSync(`active-${org}.json`, JSON.stringify({ active: activeCount }));
  console.log(JSON.stringify(finalizable));
}
main();
