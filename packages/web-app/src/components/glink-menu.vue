<script setup lang="ts">
import { inject, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { RouteName } from '../router';
import { appKey } from '../app-context';
const open = ref(false);
const app = inject(appKey)!;
const route = useRoute();
</script>
<template>
  <div
    class="glink-menu"
    @keydown.esc="open = false"
  >
    <button
      class="brand"
      aria-label="Glink menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M9 15l6-6m-7 3-2 2a4 4 0 005 5l3-3m-4-8 3-3a4 4 0 015 5l-2 2"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        />
      </svg>
      <strong>Glink</strong>
    </button>
    <template v-if="open">
      <div
        class="dismiss"
        @click="open = false"
      />
      <div
        class="menu ws-panel"
        role="menu"
      >
        <router-link
          role="menuitem"
          :to="{ name: RouteName.starter }"
          @click="open = false"
        >
          返回开始页面
        </router-link>
        <router-link
          role="menuitem"
          :to="{
            name: RouteName.worktree,
            params: {
              worktreePath:
                route.name === RouteName.worktree
                  ? route.params.worktreePath
                  : app.gitRepoService.repoPath.replaceAll('\\', '/'),
            },
          }"
          @click="open = false"
        >
          仓库浏览
        </router-link>
      </div>
    </template>
  </div>
</template>
<style scoped lang="less">
.glink-menu {
  position: relative;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.6em;
  padding: 0.3em 0.4em;
  color: var(--ws-blue);
}
strong {
  color: var(--ws-text);
  font-size: 1.25em;
  letter-spacing: -0.03em;
}
.dismiss {
  position: fixed;
  inset: 0;
  z-index: 90;
}
.menu {
  position: absolute;
  top: calc(100% + 0.5em);
  left: 0;
  width: 15em;
  padding: 0.4em;
  z-index: 91;
  box-shadow: 0 0.5em 2em #242a3420;
}
.menu a {
  display: block;
  color: inherit;
  text-decoration: none;
  border-radius: 0.3em;
  width: 100%;
  text-align: left;
  padding: 0.65em 0.8em;
}
.menu a:hover {
  background: var(--ws-active);
}
</style>
