import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { readUtf8OrFail } from "../scripts/lib/encoding.mjs";

test("readUtf8OrFail - rejects UTF-16 LE", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pxl-encoding-test-"));
  const p = join(tmp, "file.txt");
  writeFileSync(p, Buffer.from([0xff, 0xfe, 0x61, 0x00]));
  assert.throws(() => readUtf8OrFail(p), /is UTF-16 LE/);
});

test("readUtf8OrFail - rejects UTF-16 BE", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pxl-encoding-test-"));
  const p = join(tmp, "file.txt");
  writeFileSync(p, Buffer.from([0xfe, 0xff, 0x00, 0x61]));
  assert.throws(() => readUtf8OrFail(p), /is UTF-16 BE/);
});

test("readUtf8OrFail - rejects UTF-8 BOM", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pxl-encoding-test-"));
  const p = join(tmp, "file.txt");
  writeFileSync(p, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
  assert.throws(() => readUtf8OrFail(p), /has a UTF-8 BOM/);
});

test("readUtf8OrFail - accepts plain UTF-8", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pxl-encoding-test-"));
  const p = join(tmp, "file.txt");
  writeFileSync(p, Buffer.from([0x61, 0x62, 0x63]));
  assert.equal(readUtf8OrFail(p), "abc");
});
