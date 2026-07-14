import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
  },
  {
    path: '/:org/a/:assignmentId',
    name: 'assignment',
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
    path: '/usage',
    name: 'usage-overview',
    component: () => import('../views/UsageOverviewView.vue'),
  },
  {
    path: '/setup',
    name: 'setup',
    component: () => import('../views/SetupView.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// Per-route document titles so tabs, history, and bookmarks are tellable
// apart. Falls back to the bare app name on the home page.
const APP_NAME = 'PXL Classroom'
router.afterEach((to) => {
  let page = ''
  switch (to.name) {
    case 'assignment':
      page = `${to.params.assignmentId} — Accept assignment`
      break
    case 'dashboard':
      page = to.params.org ? `Dashboard — ${to.params.org}` : 'Dashboard'
      break
    case 'admin':
      page = `Admin Panel — ${to.params.org}`
      break
    case 'assignment-detail':
      page = `${to.params.assignmentId} — ${to.params.org}`
      break
    case 'usage-org':
      page = `Usage — ${to.params.org}`
      break
    case 'usage-overview':
      page = 'Usage — all organizations'
      break
    case 'setup':
      page = 'App setup'
      break
    case 'not-found':
      page = 'Page not found'
      break
  }
  document.title = page ? `${page} · ${APP_NAME}` : APP_NAME
})

export default router
