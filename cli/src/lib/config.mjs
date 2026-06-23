// PXL Classroom CLI — config + token cache.
//
// Token cache:   ~/.config/pxl-classroom/token           (0600, JSON)
// Config:        ~/.config/pxl-classroom/config.json     (0600, JSON)
//
// XDG_CONFIG_HOME is honored on POSIX; on Windows we fall back to
// %APPDATA%/pxl-classroom. Permissions are best-effort on Windows
// (relies on user-profile ACLs).

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync } from "node:fs";

function configDir() {
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "pxl-classroom");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length ? xdg : join(homedir(), ".config");
  return join(base, "pxl-classroom");
}

function ensureDir() {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pathFor(name) {
  return join(ensureDir(), name);
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonSecure(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (platform() !== "win32") {
    try { chmodSync(file, 0o600); } catch {}
  }
}

export function loadToken() {
  return readJson(pathFor("token"));
}

export function saveToken(tokenRecord) {
  writeJsonSecure(pathFor("token"), tokenRecord);
}

export function clearToken() {
  const file = pathFor("token");
  if (existsSync(file)) unlinkSync(file);
}

export function loadConfig() {
  return readJson(pathFor("config.json")) || {};
}

export function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  writeJsonSecure(pathFor("config.json"), merged);
  return merged;
}

export function configPath() {
  return pathFor("config.json");
}

export function tokenPath() {
  return pathFor("token");
}

// Resolves the client_id from flag > env > config. Throws if none found.
export function resolveClientId({ flag } = {}) {
  const id = flag || process.env.PXL_APP_CLIENT_ID || loadConfig().client_id;
  if (!id) {
    throw new Error(
      "no client_id configured. Pass --client-id <id>, set PXL_APP_CLIENT_ID, or run `pxl-classroom auth login --client-id <id>`.",
    );
  }
  return id;
}
