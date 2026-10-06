// What the Organization page says about the organization itself (2026-10-06):
// its GitHub plan and what that means for a course, who is in it, its Actions
// this month, and its repositories. Each line only from what GitHub answered.
//
// THE PLAN DECIDES WHAT A DEADLINE DOES. Student repositories are private, and
// on GitHub Free an organization's private repositories have no rulesets, no
// protected branches and no environments (docs.github.com, "GitHub's plans";
// "Managing environments for deployment" - measured for rulesets on 2026-09-09,
// lib/audit.mjs `organizationPlanFinding`). So "Pushing stops" falls back to
// making the repository read-only. The numbers are GitHub's published ones:
// Actions minutes included per month for private repositories, and how many
// jobs run at once on standard runners ("Actions limits").
//
// GitHub returns the plan, the base permission and the counts of outside
// collaborators and private repositories to ORGANIZATION OWNERS only. Absent
// is not a free plan or nobody: it is unknown, and the card says only an
// owner can see it rather than guessing.
//
// Pure and isomorphic: the page passes what the API returned, the test runs it.

/** What each plan means here. Unknown plans get the name and no claims. */
export const PLAN_FACTS = Object.freeze({
  free: {
    name: "GitHub Free",
    lines: [],
    more: [
      '"Pushing stops" at a deadline makes the repository read-only instead, so students also lose Actions, secrets and settings until you reopen it.',
      "Student repositories cannot use protected branches or environments.",
      "2,000 Actions minutes a month for private repositories, and up to 20 jobs at once: grading queues when a whole class pushes together.",
      "GitHub Team is free for verified teachers.",
    ],
    upgrade: true,
  },
  team: {
    name: "GitHub Team",
    // Only what a lecturer plans around. What Team makes work is the default
    // and says nothing; Free's `more` is where the differences are.
    lines: ["3,000 Actions minutes a month for private repositories, and up to 60 jobs at once."],
    more: [],
    upgrade: false,
  },
});

/** Where a teacher upgrades an organization to GitHub Team at no cost. */
export const TEACHER_UPGRADE_URL = "https://education.github.com/globalcampus/teacher";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Kilobytes, as GitHub's `disk_usage` gives them, in a unit a person reads. */
export function formatDiskUsage(kb) {
  if (!Number.isFinite(kb) || kb < 0) return null;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  if (kb < 1024 * 1024) return `${Math.round(kb / 1024)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
}

/**
 * The month's Actions, from the billing usage report's items: minutes and what
 * was charged beyond the included amount. Null when there were no items read.
 * Not "X of 3,000": the report does not say which repositories were private,
 * and public ones (the brokers) use no included minutes.
 *
 * @param {Array<{product?: string, unitType?: string, quantity?: number, netAmount?: number}>|null} items
 */
export function actionsThisMonth(items) {
  if (!Array.isArray(items)) return null;
  const actions = items.filter((i) => i?.product === "actions" && String(i?.unitType || "").toLowerCase() === "minutes");
  const minutes = Math.round(actions.reduce((s, i) => s + (Number(i.quantity) || 0), 0));
  const charged = actions.reduce((s, i) => s + (Number(i.netAmount) || 0), 0);
  return { minutes, charged: Math.round(charged * 100) / 100 };
}

/**
 * The card, line by line.
 *
 * @param {object} args
 * @param {{plan?: {name?: unknown}|null, collaborators?: unknown, default_repository_permission?: unknown,
 *          total_private_repos?: unknown, public_repos?: unknown, disk_usage?: unknown}|null} args.org
 *   `GET /orgs/{org}` as returned, or null if unread
 * @param {number|null} [args.owners] owners counted from the member list, or null
 * @param {number|null} [args.members] members counted (owners included), or null
 * @param {Array<object>|null} [args.billingItems] this month's billing usage items, or null
 */
export function orgFacts({ org, owners = null, members = null, billingItems = null }) {
  const planName = typeof org?.plan?.name === "string" ? org.plan.name.toLowerCase() : null;
  if (!planName) {
    return { ownerOnly: true, plan: null, people: null, membersRead: null, actions: null, repositories: null };
  }

  const known = PLAN_FACTS[planName];
  const plan = known
    ? { key: planName, name: known.name, lines: known.lines, more: known.more, upgradeUrl: known.upgrade ? TEACHER_UPGRADE_URL : null }
    : { key: planName, name: `GitHub ${planName.charAt(0).toUpperCase()}${planName.slice(1)}`, lines: [], more: [], upgradeUrl: null };

  const collaborators = count(org.collaborators);
  const ownerCount = count(owners);
  const memberCount = count(members);
  const parts = [];
  if (ownerCount !== null) parts.push(plural(ownerCount, "owner"));
  if (memberCount !== null && ownerCount !== null && memberCount >= ownerCount) parts.push(plural(memberCount - ownerCount, "other member"));
  else if (memberCount !== null) parts.push(plural(memberCount, "member"));
  if (collaborators !== null) parts.push(`${plural(collaborators, "outside collaborator")} (students are added this way)`);
  const people = parts.length ? parts.join(" · ") : null;

  // The floor every MEMBER gets on every repository (lib/audit.mjs
  // baseRepositoryPermissionFinding): said only when it is more than none.
  const base = typeof org.default_repository_permission === "string" ? org.default_repository_permission : null;
  const membersRead = base === "read"
    ? "Every member can read every repository, the roster included."
    : base === "write" || base === "admin"
      ? `Every member can ${base === "admin" ? "administer" : "write to"} every repository, so a deadline lock cannot stop them.`
      : null;

  const month = actionsThisMonth(billingItems);
  const actions = month
    ? `${new Intl.NumberFormat("en-US").format(month.minutes)} ${month.minutes === 1 ? "minute" : "minutes"} this month${month.charged > 0 ? `, $${month.charged.toFixed(2)} charged beyond what is included` : ", nothing charged"}.`
    : null;

  const priv = count(org.total_private_repos);
  const pub = count(org.public_repos);
  const disk = formatDiskUsage(org.disk_usage);
  const repoParts = [];
  if (priv !== null) repoParts.push(`${priv} private`);
  if (pub !== null) repoParts.push(`${pub} public`);
  const repositories = repoParts.length
    ? `${repoParts.join(" and ")} ${(priv ?? 0) + (pub ?? 0) === 1 ? "repository" : "repositories"}${disk ? `, ${disk} in all` : ""}.`
    : null;

  return { ownerOnly: false, plan, people, membersRead, actions, repositories };
}
