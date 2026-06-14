#!/usr/bin/env node
// PXL Classroom — Spike 1: Provisioning
//
// Creates a private org repo from a private template, grants a student admin,
// records the immutable repo ID, and writes a status record. Idempotent: a
// re-run reuses the existing repo instead of creating a duplicate.
//
// Auth: expects GITHUB_TOKEN to be a GitHub App INSTALLATION token (minted by
// actions/create-github-app-token in CI). For local mechanics checks you can
// pass a PAT, but only DRY_RUN=1 (read-only) is appropriate with a PAT.
//
// No npm dependencies — uses Node 18+ global fetch.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const env = (k, d) => process.env[k] ?? d;

const cfg = {
  token: env("GITHUB_TOKEN") || env("GH_TOKEN"),
  org: env("ORG"),
  templateOwner: env("TEMPLATE_OWNER"),
  templateRepo: env("TEMPLATE_REPO"),
  targetRepo: env("TARGET_REPO"),
  studentLogin: env("STUDENT_LOGIN"),
  permission: env("STUDENT_PERMISSION", "admin"),
  isPrivate: env("PRIVATE", "true") !== "false",
  dryRun: env("DRY_RUN", "0") === "1",
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
};

const required = ["token", "org", "templateOwner", "templateRepo", "targetRepo", "studentLogin"];
const missing = required.filter((k) => !cfg[k]);
if (missing.length) {
  console.error(`Missing required env: ${missing.map((k) => k.toUpperCase()).join(", ")}`);
  process.exit(2);
}

const status = {
  spike: "01-provisioning",
  startedAt: new Date().toISOString(),
  dryRun: cfg.dryRun,
  input: {
    org: cfg.org,
    template: `${cfg.templateOwner}/${cfg.templateRepo}`,
    targetRepo: cfg.targetRepo,
    studentLogin: cfg.studentLogin,
    permission: cfg.permission,
    private: cfg.isPrivate,
  },
  steps: [],
  outcome: null,
  repository: null,
};

function record(step, detail) {
  status.steps.push({ step, at: new Date().toISOString(), ...detail });
  const tag = detail.ok === false ? "FAIL" : "ok";
  console.log(`[${tag}] ${step}${detail.note ? ` — ${detail.note}` : ""}`);
}

async function gh(method, path, body, { retries = 4 } = {}) {
  const url = path.startsWith("http") ? path : `${cfg.apiBase}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pxl-classroom-spike-01",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Retry on transient server errors and secondary rate limits.
    const retriable = res.status >= 500 || res.status === 429 || res.status === 403;
    if (retriable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoff = retryAfter * 1000 || Math.min(30000, 2 ** attempt * 1000);
      // 403 is only retried when it looks like a rate limit, not a real auth error.
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status !== 403 || remaining === "0") {
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    return { status: res.status, ok: res.ok, data };
  }
}

async function main() {
  // 1. Sanity-check the token is live. GitHub App installation tokens have no
  //    user, so GET /user returns 403 — use /rate_limit, which any valid token
  //    (installation token or PAT) can call.
  const ping = await gh("GET", "/rate_limit");
  record("auth: token live", {
    ok: ping.ok,
    note: ping.ok ? "token accepted" : `HTTP ${ping.status}`,
  });
  if (!ping.ok) { status.outcome = "fail:auth"; return finish(1); }

  // 2. Validate template exists and is a template.
  const tpl = await gh("GET", `/repos/${cfg.templateOwner}/${cfg.templateRepo}`);
  record("validate template", {
    ok: tpl.ok,
    note: tpl.ok
      ? `private=${tpl.data.private} is_template=${tpl.data.is_template}`
      : `HTTP ${tpl.status} ${tpl.data?.message ?? ""}`,
  });
  if (!tpl.ok) { status.outcome = "fail:template-missing"; return finish(1); }
  if (!tpl.data.is_template) {
    record("validate template", { ok: false, note: "repository is not marked as a template" });
    status.outcome = "fail:not-a-template"; return finish(1);
  }

  // 3. Idempotency check: does the target repo already exist?
  const existing = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}`);
  const alreadyExists = existing.status === 200;
  record("idempotency check", {
    ok: existing.status === 200 || existing.status === 404,
    note: alreadyExists ? `exists (id=${existing.data.id}) — will reuse` : "does not exist — will create",
  });

  // 4. Create from template (skipped if exists, or in dry-run).
  let repo = alreadyExists ? existing.data : null;
  if (!alreadyExists) {
    if (cfg.dryRun) {
      record("create from template", { ok: true, note: "DRY_RUN: skipped POST /generate" });
    } else {
      const gen = await gh("POST", `/repos/${cfg.templateOwner}/${cfg.templateRepo}/generate`, {
        owner: cfg.org,
        name: cfg.targetRepo,
        private: cfg.isPrivate,
        include_all_branches: false,
      });
      record("create from template", {
        ok: gen.ok,
        note: gen.ok ? `created id=${gen.data.id} ${gen.data.html_url}` : `HTTP ${gen.status} ${gen.data?.message ?? ""}`,
      });
      if (!gen.ok) { status.outcome = "fail:create"; return finish(1); }
      repo = gen.data;
    }
  }

  // 5. Grant the student admin (skipped in dry-run).
  if (cfg.dryRun) {
    record("grant student admin", { ok: true, note: `DRY_RUN: skipped PUT collaborators/${cfg.studentLogin}` });
  } else {
    const add = await gh("PUT", `/repos/${cfg.org}/${cfg.targetRepo}/collaborators/${cfg.studentLogin}`, {
      permission: cfg.permission,
    });
    // 201 = invitation created, 204 = already a collaborator at that level.
    record("grant student admin", {
      ok: add.status === 201 || add.status === 204,
      note: add.status === 201 ? "invitation created" : add.status === 204 ? "already a collaborator" : `HTTP ${add.status} ${add.data?.message ?? ""}`,
    });
    if (!(add.status === 201 || add.status === 204)) { status.outcome = "fail:grant"; return finish(1); }
  }

  // 6. Re-read for the authoritative record (skip if dry-run created nothing).
  if (repo) {
    status.repository = {
      id: repo.id,
      node_id: repo.node_id,
      full_name: repo.full_name,
      html_url: repo.html_url,
      private: repo.private,
      created_at: repo.created_at,
    };
  }

  status.outcome = cfg.dryRun
    ? "dry-run:ok"
    : alreadyExists
      ? "reused"
      : "created";
  record("done", { ok: true, note: status.outcome });
  return finish(0);
}

async function finish(code) {
  status.finishedAt = new Date().toISOString();
  const outPath = `spikes/01-provisioning/out/status-${cfg.org}-${cfg.targetRepo}.json`;
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(status, null, 2) + "\n");
    console.log(`\nStatus written: ${outPath}`);
  } catch (e) {
    console.error(`Could not write status file: ${e.message}`);
  }
  process.exit(code);
}

main().catch((e) => {
  record("unexpected error", { ok: false, note: e.message });
  status.outcome = "fail:exception";
  finish(1);
});
