const https = require('https');

const actions = [
  'actions/upload-artifact@v4',
  'actions/download-artifact@v4',
  'actions/github-script@v7',
  'actions/configure-pages@v5',
  'actions/upload-pages-artifact@v3',
  'actions/deploy-pages@v4'
];

async function fetchSha(repo, tag) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.github.com/repos/${repo}/git/refs/tags/${tag}`, {
      headers: { 'User-Agent': 'Node.js' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.object ? json.object.sha : null);
        } catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

(async () => {
  for (const action of actions) {
    const [repo, tag] = action.split('@');
    const sha = await fetchSha(repo, tag);
    console.log(`${action} -> ${sha}`);
  }
})();
