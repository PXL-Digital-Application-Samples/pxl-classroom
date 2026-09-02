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
    path: '/dashboard/:org?',
    name: 'dashboard',
    component: () => import('../views/DashboardView.vue'),
    props: true,
  },
  {
    path: '/dashboard/:org/admin',
    name: 'admin',
    component: () => import('../views/AdminView.vue'),
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
    case 'admin':
      page = `Admin Panel - ${to.params.org}`
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
