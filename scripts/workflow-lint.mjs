import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { parse } from 'yaml';
import { tmpdir } from 'os';

let hasError = false;

function lintBash(scriptContent, fileContext) {
  // Convert Windows path to WSL-friendly or bash-friendly path if necessary
  let tmpFile = join(tmpdir(), `lint-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(tmpFile, scriptContent);
  
  // Bash might need forward slashes
  const bashTmpFile = tmpFile.replace(/\\/g, '/');
  
  try {
    // If bash is running in WSL or MSYS, it might need to resolve C:/ to /mnt/c/ or /c/
    // Let's use standard git bash / MSYS path conversion if possible, or just pass it in.
    // Given the error, we should pass the contents via stdin instead of relying on file paths.
    execSync(`bash -n`, { input: scriptContent, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(`\n[ERROR] Syntax error in ${fileContext}:`);
    if (err.stderr) console.error(err.stderr.toString().trim());
    else if (err.stdout) console.error(err.stdout.toString().trim());
    else console.error(err.message);
    hasError = true;
  } finally {
    try { unlinkSync(tmpFile); } catch(e) {}
  }
}

function checkStep(step, context) {
  if (!step.run) return;
  const shell = step.shell || 'bash';
  if (!shell.includes('bash') && !shell.includes('sh')) return;

  // Lint rule from Phase 9: greps for writeFile.*JSON.stringify not preceded by validateAgainst
  if (step.run.includes('writeFile') && step.run.includes('JSON.stringify') && !step.run.includes('validateAgainst')) {
    console.error(`\n[ERROR] Missing validateAgainst before JSON write in ${context}`);
    hasError = true;
  }

  lintBash(step.run, context);
}

function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  let doc;
  try {
    doc = parse(content);
  } catch (e) {
    console.error(`\n[ERROR] Failed to parse YAML: ${filePath}`);
    hasError = true;
    return;
  }
  
  if (!doc) return;

  if (doc.jobs) {
    for (const [jobId, job] of Object.entries(doc.jobs)) {
      if (!job.steps) continue;
      job.steps.forEach((step, i) => checkStep(step, `${filePath} -> job '${jobId}' step ${i + 1}`));
    }
  }
  if (doc.runs && doc.runs.steps) {
    doc.runs.steps.forEach((step, i) => checkStep(step, `${filePath} -> composite step ${i + 1}`));
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (['node_modules', '.git', 'frontend'].includes(entry)) continue;
      walk(fullPath);
    } else if (fullPath.endsWith('.yml') || fullPath.endsWith('.yaml')) {
      if (fullPath.includes('.github\\workflows') || fullPath.includes('.github/workflows') || fullPath.endsWith('action.yml')) {
        scanFile(fullPath);
      }
    }
  }
}

walk('.');

if (hasError) {
  process.exit(1);
} else {
  console.log("Workflow lint passed.");
}
