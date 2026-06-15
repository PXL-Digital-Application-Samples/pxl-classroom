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

export default router
