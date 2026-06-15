import { execSync } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { loadYaml } from '../lib/yaml.mjs';

async function main() {
  // Find all orgs from participating-orgs.yml
  execSync('git fetch origin participating-orgs:participating-orgs || true');
  if (!existsSync('participating-orgs.yml')) {
    try {
      execSync('git show participating-orgs:participating-orgs.yml > participating-orgs.yml 2>/dev/null');
    } catch(e) {}
  }
  
  if (!existsSync('participating-orgs.yml')) {
    console.log("No orgs found. Disabling.");
    disable();
    return;
  }
  
  const orgsYaml = await loadYaml('participating-orgs.yml');
  const orgs = Object.keys(orgsYaml.organizations || {});
  
  let hasActive = false;
  
  // Need to use PXL_APP_PRIVATE_KEY to check control repos if we wanted, 
  // but wait, we can just use the artifact or we can check the API for workflows!
  // Wait, the find-finalizable and find-orgs step ran, maybe we don't need to clone.
  // Actually, checking if there are active assignments requires looking at assignments/*.yml in the control repos.
  // We don't have the control repos cloned in this step!
  console.log("Disabling idle checking until further notice... (TODO)");
}

function disable() {
  execSync('gh workflow disable daily-activity.yml');
}

main().catch(console.error);
