const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../.github/workflows');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.yml'));

const replacements = {
  'actions/checkout@v4': 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
  'actions/setup-node@v4': 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0',
  'actions/create-github-app-token@v1': 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0',
  'actions/upload-artifact@v4': 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.0',
  'actions/download-artifact@v4': 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.1.9',
  'actions/github-script@v7': 'actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7.0.1',
  'actions/configure-pages@v5': 'actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5.0.0',
  'actions/upload-pages-artifact@v3': 'actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa # v3.0.1',
  'actions/deploy-pages@v4': 'actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4.0.5',
  'PXL-Digital-Application-Samples/pxl-classroom/provisioning@v1': './provisioning',
  'PXL-Digital-Application-Samples/pxl-classroom/acceptance@v1': './acceptance',
};

for (const file of files) {
  const filepath = path.join(dir, file);
  let content = fs.readFileSync(filepath, 'utf8');
  let changed = false;

  for (const [find, replace] of Object.entries(replacements)) {
    // Regex to match "uses: find" with optional trailing spaces/comments
    // e.g., "uses: actions/checkout@v4" or "uses: actions/checkout@v4 # TODO pin..."
    const regex = new RegExp(`uses:\\s+${find}(?:\\s+#.*)?`, 'g');
    if (regex.test(content)) {
      content = content.replace(regex, `uses: ${replace}`);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filepath, content);
    console.log(`Updated ${file}`);
  }
}
