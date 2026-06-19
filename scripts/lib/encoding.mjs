import { readFileSync } from "node:fs";

export function readUtf8OrFail(path) {
  const buf = readFileSync(path);
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    throw new Error(`${path} is UTF-16 LE. Re-encode as UTF-8 (LF, no BOM) and re-commit.`);
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    throw new Error(`${path} is UTF-16 BE. Re-encode as UTF-8 (LF, no BOM) and re-commit.`);
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new Error(`${path} has a UTF-8 BOM. Re-encode without a BOM and re-commit.`);
  }
  return buf.toString("utf8");
}
