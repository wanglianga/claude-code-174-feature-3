import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuthStore } from './store';

const routes = [
  { path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } },
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./views/Dashboard.vue') },
  { path: '/houses', component: () => import('./views/HouseList.vue') },
  { path: '/houses/:id', component: () => import('./views/HouseDetail.vue') },
  { path: '/inspect', component: () => import('./views/NewInspection.vue') },
  { path: '/teams', component: () => import('./views/Teams.vue') },
  { path: '/rain-report', component: () => import('./views/RainReport.vue') },
  { path: '/risk-events', component: () => import('./views/RiskEvents.vue') },
  { path: '/risk-events/:id', component: () => import('./views/RiskEventDetail.vue') },
  { path: '/my-tasks', component: () => import('./views/MyTasks.vue') },
];

const router = createRouter({ history: createWebHashHistory(), routes });
router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.token) return '/login';
  if (to.path === '/login' && auth.token) return '/dashboard';
  return true;
});
export default router;
