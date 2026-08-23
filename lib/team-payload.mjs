// PXL Classroom - group-acceptance payload parsing.
//
// The broker repository is PUBLIC and its workflow holds App credentials, so it
// must never parse attacker-controlled text. An issue body interpolated into a
// shell there was arbitrary code execution against the App private key: any
// GitHub account could open an issue on any broker. The broker now forwards
// only the issue NUMBER, and the hub fetches and parses the body here.
//
// Pure: no fs, no fetch. scripts/read-team-payload.mjs is the carrier.

// Same slug shape accept.mjs enforces before touching teams/<id>/<slug>.json.
const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEAM_ACTIONS = new Set(["join", "create", "switch"]);
const MAX_TEAM_NAME = 100;

// Team names are free text and end up in `name=value` lines appended to
// GITHUB_OUTPUT, so a control character - a newline above all - would forge
// additional outputs downstream.
export function sanitizeTeamName(value) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_TEAM_NAME);
}

export function parseTeamPayload({ body, title } = {}) {
  let slug = "";
  let name = "";
  let action = "";

  if (typeof body === "string" && body.trim()) {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null; // Not JSON - the title form below is the fallback.
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.team_slug === "string") slug = parsed.team_slug.trim();
      name = sanitizeTeamName(parsed.team_name);
      if (typeof parsed.team_action === "string") action = parsed.team_action.trim();
    }
  }

  if (!slug && typeof title === "string") {
    const m = title.trim().match(/^team:(.+)$/);
    if (m) slug = m[1].trim();
  }

  if (!TEAM_SLUG.test(slug)) slug = "";
  if (!TEAM_ACTIONS.has(action)) action = "";

  return { team_slug: slug, team_name: name, team_action: action };
}
