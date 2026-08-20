import { existsSync } from 'node:fs';

if (existsSync('.env.test')) {
  process.loadEnvFile('.env.test');
}

const accounts = [
  { role: 'Lecturer 1', login: process.env.TEST_LECTURER_LOGIN, token: process.env.TEST_LECTURER_TOKEN },
  { role: 'Lecturer 2', login: process.env.TEST_LECTURER2_LOGIN, token: process.env.TEST_LECTURER2_TOKEN },
  { role: 'Student 1',  login: process.env.TEST_STUDENT1_LOGIN,  token: process.env.TEST_STUDENT1_TOKEN },
  { role: 'Student 2',  login: process.env.TEST_STUDENT2_LOGIN,  token: process.env.TEST_STUDENT2_TOKEN },
];

console.log('Testing GitHub API tokens for all 4 accounts...\n');

for (const acc of accounts) {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${acc.token}`,
        'User-Agent': 'pxl-classroom-test-check',
      },
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`[OK] ${acc.role}: Authenticated as @${data.login} (ID: ${data.id})`);
    } else {
      console.error(`[FAIL] ${acc.role} (@${acc.login}): HTTP ${res.status} ${res.statusText}`);
    }
  } catch (e) {
    console.error(`[ERROR] ${acc.role}: ${e.message}`);
  }
}
