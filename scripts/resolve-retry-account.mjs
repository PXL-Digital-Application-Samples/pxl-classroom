#!/usr/bin/env node
// Which account a lecturer's Retry is for.
//
// The row they pressed it on names a login, and a login can have changed hands:
// asked by name, a student who renamed got a red "no GitHub account named", and
// one whose old name somebody else has since registered had that person's id
// taken for theirs, their record replaced and the stranger invited. What this
// repository has on record says which account the row is, so that account's
// login today is who the retry is for. Only a login nothing here has on record is
// looked up by name.
//
// Env: DATA_DIR, ASSIGNMENT_ID, GITHUB_LOGIN, GITHUB_TOKEN, GITHUB_OUTPUT
// Outputs: id, login

import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { acceptancesDir } from "../lib/control-layout.mjs";
import { gh } from "../lib/gh.mjs";
import { sameLogin } from "../lib/github-login.mjs";
import { accountsOnRecord, currentLogin } from "../lib/login-rename.mjs";

const dataDir = process.env.DATA_DIR || "control";
const assignmentId = process.env.ASSIGNMENT_ID || "";
const login = process.env.GITHUB_LOGIN || "";

function give(id, name) {
  if (name !== login) console.log(`[ok] this account goes by @${name} now, not @${login}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `id=${id}\nlogin=${name}\n`);
  process.exit(0);
}

function stop(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

/** This assignment's own record first: it can only be about this row. */
function idOnRecord() {
  const dir = join(dataDir, acceptancesDir(assignmentId));
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const file = names.find((n) => n.endsWith(".json") && sameLogin(n.slice(0, -".json".length), login));
  if (file) {
    try {
      const id = JSON.parse(readFileSync(join(dir, file), "utf8"))?.github_id;
      if (Number.isInteger(id)) return id;
    } catch {
      // Unreadable: the rest of the organization may still say.
    }
  }
  const holders = [...accountsOnRecord(dataDir)].filter(([, held]) => [...held].some((h) => sameLogin(h, login)));
  return holders.length === 1 ? holders[0][0] : null;
}

const id = idOnRecord();
if (id !== null) {
  const now = await currentLogin(gh, id);
  if (now) give(id, now);
  stop(`The account ${login} accepted under (id ${id}) could not be read: it may have been deleted. Nothing was changed.`);
}

const res = await gh("GET", `/users/${encodeURIComponent(login)}`);
if (!res.ok) stop(`No GitHub account named ${login}, or it could not be looked up (HTTP ${res.status}). Check the spelling.`);
if (!Number.isInteger(res.data?.id)) stop(`GitHub returned no numeric account id for ${login}.`);
give(res.data.id, typeof res.data.login === "string" ? res.data.login : login);
