import { createRouter, createWebHistory } from 'vue-router';

export enum RouteName {
  starter = 'starter',
  workspace = 'workspace',
  worktree = 'worktree',
  notFound = 'not-found',
}

export function createGlinkRouter(defaultWorktreePath: string) {
  return createRouter({
    history: createWebHistory(),
    routes: [
      {
        path: '/',
        name: RouteName.starter,
        component: () => import('./components/starter-page.vue'),
      },
      {
        path: '/workspace/:name',
        name: RouteName.workspace,
        props: true,
        component: () => import('./components/workspace/workspace-route-view.vue'),
      },
      {
        path: '/repository',
        redirect: {
          name: RouteName.worktree,
          params: { worktreePath: defaultWorktreePath.replaceAll('\\', '/') },
        },
      },
      {
        path: '/worktree/:worktreePath',
        name: RouteName.worktree,
        props: true,
        component: () => import('./components/git/repository-page.vue'),
      },
      {
        path: '/:pathMatch(.*)*',
        name: RouteName.notFound,
        component: () => import('./components/route-not-found.vue'),
      },
    ],
  });
}
