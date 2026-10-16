// The Deadline Sentinel's timelines for one assignment, read from a control
// checkout: `lockdowns/<id>/sentinel-*.json`. What they MEAN is
// lib/sentinel-window.mjs; this only reads them, once, for every script that
// asks (acceptance, lockdown, the stop release).
//
// Node only, through a dynamic import, so a module on the SPA's graph that
// imports lib/sentinel-window.mjs never pulls in a builtin.

/**
 * @param {string} dir `<checkout>/lockdowns/<id>`
 * @param {{onUnreadable?: (name: string, error: Error) => void}} [opts]
 * @returns {Promise<any[]>} the parsed documents; an unreadable one is left
 *   out (not evidence of a stop), and a missing directory is none
 */
export async function readSentinelTimelines(dir, { onUnreadable } = {}) {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const names = await readdir(dir).catch(() => []);
  const docs = [];
  for (const name of names.filter((n) => /^sentinel-.*\.json$/.test(n)).sort()) {
    try {
      docs.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch (e) {
      onUnreadable?.(name, /** @type {Error} */ (e));
    }
  }
  return docs;
}
