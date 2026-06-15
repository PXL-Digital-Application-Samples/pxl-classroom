import fs from 'node:fs';
import path from 'node:path';

const controlDir = process.argv[2] || '.';
const org = process.argv[3];
const acceptDir = path.join(controlDir, 'acceptances');
const pending = [];

if (fs.existsSync(acceptDir)) {
  for (const assignment of fs.readdirSync(acceptDir)) {
    const assignmentDir = path.join(acceptDir, assignment);
    if (fs.statSync(assignmentDir).isDirectory()) {
      for (const file of fs.readdirSync(assignmentDir)) {
        if (file.endsWith('.json')) {
          const data = JSON.parse(fs.readFileSync(path.join(assignmentDir, file), 'utf8'));
          if (data.status === 'accepted') {
            pending.push({
              org,
              assignment_id: data.assignment_id,
              github_login: data.github_login,
            });
          }
        }
      }
    }
  }
}

console.log(JSON.stringify(pending));
