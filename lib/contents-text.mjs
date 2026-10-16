// The text of a file read through GitHub's Contents API.
//
// The API answers `content` as base64 with a newline every 60 characters.
// Isomorphic: `atob` in the browser and in Node 24, `Buffer` only where
// there is no `atob`, so the SPA can import this without a Node builtin.

/**
 * @param {unknown} b64 the `content` field of a Contents API answer
 * @returns {string}
 */
export function contentsText(b64) {
  const compact = String(b64).replace(/\n/g, "");
  if (typeof atob === "function") {
    return new TextDecoder().decode(Uint8Array.from(atob(compact), (c) => c.charCodeAt(0)));
  }
  return Buffer.from(compact, "base64").toString("utf8");
}
