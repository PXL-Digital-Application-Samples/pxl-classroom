import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
  },
  {
    // Invitation link. The token is the capability: the broker verifies it
    // before any credential is in scope, so a URL nobody was given cannot
    // trigger work. The assignment id is not readable from it by design.
    path: '/:org/i/:inviteToken',
    name: 'invitation',
    component: () => import('../views/AssignmentView.vue'),
    props: true,
  },
  {
    // The SAME secret, asking a smaller question: who is this account? It binds
    // a GitHub login to an institutional address and provisions nothing.
    //
    // A separate ROUTE rather than a flag on the one above, because the two
    // pages must not be able to turn into each other: this one may never offer
    // to accept anything, and a route is harder to lose than a query
    // parameter. The purpose is also inside the signature the page produces -
    // see lib/acceptance-signature.mjs - so relabelling the request is refused
    // on the broker too, not merely discouraged here.
    path: '/:org/c/:inviteToken',
    name: 'confirm-email',
    component: () => import('../views/ConfirmEmailView.vue'),
    props: true,
  },
  {
    path: '/dashboard/:org?',
    name: 'dashboard',
    component: () => import('../views/DashboardView.vue'),
    props: true,
  },
  {
    // THERE IS NO ADMIN PAGE ANY MORE (BETA-UX.md, 2026-10-02): the editor is
    // each assignment's Settings tab, creating one is its own page, and what was
    // the organization's is under Organization. Old links still land: `?edit=`
    // on that assignment's settings, `?new=1` on a new one, anything else on the
    // assignment list. Every branch names its `query`: vue-router keeps the old
    // one on a redirect that does not, so `?new=1` would ride along.
    path: '/dashboard/:org/admin',
    name: 'admin',
    redirect: (to) => {
      const { edit, new: isNew, action, ...rest } = to.query
      if (edit) return { name: 'assignment-settings', params: { org: to.params.org, assignmentId: String(edit) }, query: rest }
      if (isNew === '1' || isNew === 'true' || action === 'new') return { name: 'assignment-new', params: { org: to.params.org }, query: rest }
      return { name: 'dashboard', params: { org: to.params.org }, query: rest }
    },
  },
  {
    // A new assignment: the editor on its own.
    path: '/dashboard/:org/new',
    name: 'assignment-new',
    component: () => import('../views/AdminView.vue'),
    props: (to) => ({ org: to.params.org, mode: 'new' }),
  },
  {
    // An assignment's Settings tab: the editor, for this one assignment, under
    // the same header as its Progress, Teams and Grading tabs.
    path: '/dashboard/:org/:assignmentId/settings',
    name: 'assignment-settings',
    component: () => import('../views/AdminView.vue'),
    props: (to) => ({ org: to.params.org, assignmentId: to.params.assignmentId, mode: 'single' }),
  },
  {
    // What is the organization's own: what needs the lecturer, course
    // activity, health, usage, connection. A static segment, like `roster`.
    path: '/dashboard/:org/organization',
    name: 'organization',
    component: () => import('../views/OrganizationView.vue'),
    props: true,
  },
  {
    // The organization's roster. A static segment, so it outranks
    // `:assignmentId` below whatever the order, as `admin` and `usage` do.
    path: '/dashboard/:org/roster',
    name: 'roster',
    component: () => import('../views/RosterView.vue'),
    props: true,
  },
  {
    path: '/dashboard/:org/:assignmentId',
    name: 'assignment-detail',
    component: () => import('../views/AssignmentDetailView.vue'),
    props: true,
  },
  {
    path: '/dashboard/:org/usage',
    name: 'usage-org',
    component: () => import('../views/UsageView.vue'),
    props: true,
  },
  {
    path: '/setup',
    name: 'setup',
    component: () => import('../views/SetupView.vue'),
  },
  {
    path: '/cave',
    name: 'cave',
    component: () => import('../views/CaveView.vue'),
  },
  {
    // Linked from every AppHeader, so this is not a route nothing points at.
    path: '/manual',
    name: 'manual',
    component: () => import('../views/ManualView.vue'),
  },
  // Developer workbench. It renders fabricated cohort data - invented student
  // logins, teams and reports - and it shipped to production with no link to
  // it from anywhere, on a public Pages site. Nothing found it, which is not
  // the same as nothing being able to. `import.meta.env.DEV` is statically
  // replaced at build time, so the branch and its dynamic import are dropped
  // from a production bundle entirely and the catch-all renders 404 instead.
  ...(import.meta.env.DEV
    ? [{
        path: '/sandbox',
        name: 'sandbox',
        component: () => import('../views/SandboxView.vue'),
      }]
    : []),
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      return savedPosition
    } else {
      return { top: 0 }
    }
  }
})

// Per-route document titles so tabs, history, and bookmarks are tellable
// apart. Falls back to the bare app name on the home page.
const APP_NAME = 'PXL Classroom'
router.afterEach((to) => {
  let page = ''
  switch (to.name) {
    case 'invitation':
      // No id in the title: the route does not know it until the token
      // resolves, and a link is not meant to advertise what it opens.
      page = 'Accept assignment'
      break
    case 'dashboard':
      page = to.params.org ? `Dashboard - ${to.params.org}` : 'Dashboard'
      break
    case 'assignment-new':
      page = `New assignment - ${to.params.org}`
      break
    case 'assignment-settings':
      page = `${to.params.assignmentId} settings - ${to.params.org}`
      break
    case 'organization':
      page = `Organization - ${to.params.org}`
      break
    case 'roster':
      page = `Roster - ${to.params.org}`
      break
    case 'assignment-detail':
      page = `${to.params.assignmentId} - ${to.params.org}`
      break
    case 'usage-org':
      page = `Usage - ${to.params.org}`
      break
    case 'setup':
      page = 'App setup'
      break
    case 'cave':
      page = 'Terminal'
      break
    case 'sandbox':
      page = 'Component Sandbox'
      break
    case 'not-found':
      page = 'Page not found'
      break
  }
  document.title = page ? `${page} · ${APP_NAME}` : APP_NAME
})

export default router
