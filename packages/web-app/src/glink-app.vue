<script setup lang="ts">
import { inject } from 'vue';
import { appKey } from './app-context';
import WorktreeDeleteDialog from './components/git/worktree-delete-dialog.vue';
import { RouterView, useRoute } from 'vue-router';
import { RouteName } from './router';
import GlinkMenu from './components/glink-menu.vue';
const route = useRoute();
const app = inject(appKey)!;
</script>

<template>
  <v-app>
    <v-main>
      <div
        class="glink-shell"
        :class="{ 'workspace-theme': route.name !== RouteName.worktree }"
      >
        <header class="app-bar workspace-theme">
          <glink-menu />
          <span class="muted">{{
            route.name === RouteName.workspace
              ? route.params.name
              : route.name === RouteName.worktree
                ? 'Repository'
                : 'Workspaces'
          }}</span>
        </header>
        <router-view />
      </div>
      <worktree-delete-dialog
        v-if="app.deleteWorktreePath.value"
        :key="app.deleteWorktreePath.value"
        :path="app.deleteWorktreePath.value"
        @close="app.deleteWorktreePath.value = undefined"
      />
    </v-main>
  </v-app>
</template>

<style scoped lang="less">
.glink-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: 0.75em;
  gap: 0.75em;
}
.app-bar {
  display: flex;
  gap: 1.3em;
  align-items: center;
  flex-shrink: 0;
  height: 2.7em;
  padding: 0 0.4em;
}
</style>
