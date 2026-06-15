// PXL Classroom — shared YAML loader.
//
// Replaces the five copy-pasted minimal parsers across action scripts.
// Uses the `yaml` npm package (installed at repo root by the per-action
// composite step that runs `npm ci --omit=dev`).

import { parse } from "yaml";
import { readFile } from "node:fs/promises";

export async function loadYaml(path) {
  const text = await readFile(path, "utf8");
  return parse(text);
}

export function parseYaml(text) {
  return parse(text);
}
