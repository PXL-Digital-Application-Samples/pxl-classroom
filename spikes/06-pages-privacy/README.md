# Spike 6 — Pages privacy

**Goal:** determine what can safely be served from GitHub Pages and demonstrate that roster / private repo data is not exposed publicly. (See `REQUIREMENTS.md` → *Visibility and privacy*.)

Status: **PASS**.

## The facts

- On **GitHub Team**, every Pages site is **public** (access-controlled Pages is Enterprise-only — out of scope). So *anything* published is world-readable.
- Therefore: Pages carries **only public assignment metadata**; all private state (roster, per-student status, private repo URLs) is **fetched at runtime with the requesting user's own token** — proven in Spikes 2–3 (a user's token reads only their own resources).

## The guard (this spike)

`scan.mjs` is a CI privacy gate: run it on the Pages output before publishing; a non-zero exit blocks the deploy.

```
node scan.mjs spikes/06-pages-privacy/public-sample.json   # clean  -> exit 0
node scan.mjs spikes/06-pages-privacy/leaky-sample.json    # BLOCKED -> exit 1
```

Result (2026-06-14):

```
public-sample.json  -> "clean — safe to publish"            exit 0
leaky-sample.json   -> 4 violations -> publishing BLOCKED   exit 1
   [github-token] gho_…       [email-address] jane.student@pxl.be
   [institutional-id-field] "student_id":   [roster-field] "display_name":
```

- ✅ `public-sample.json` shows the only allowed shape: public assignment metadata (id, title, dates, state, org, broker repo) — no roster, no per-student data.
- ✅ the scanner catches tokens, private keys, emails, and roster fields (`student_id`, `display_name`, `class_group`, `claim_token`) and fails the build.

## Conclusion

Pages visibility decision: **public site, public metadata only, runtime-fetch for everything private, plus this scanner as a publish gate.** Closes the "GitHub Pages visibility and administrative-data delivery" open decision.
