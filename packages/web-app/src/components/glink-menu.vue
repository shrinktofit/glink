<script setup lang="ts">
import { inject, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { RouteName } from '../router';
import { appKey } from '../app-context';
import type { WindowControls } from '../native-window';
const open = ref(false);
const app = inject(appKey)!;
const route = useRoute();
const nativeWindow: WindowControls | undefined = window.glinkWindow;

function reloadWindow() {
  open.value = false;
  window.location.reload();
}

async function openDevTools() {
  open.value = false;
  await nativeWindow!.openDevTools();
}
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
        class="menu command-menu"
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
        <hr role="separator">
        <button
          role="menuitem"
          @click="reloadWindow"
        >
          重载窗口
        </button>
        <button
          v-if="nativeWindow"
          role="menuitem"
          @click="openDevTools"
        >
          打开开发者工具
        </button>
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
  top: calc(100% + 0.25em);
  left: 0;
  z-index: 91;
}
</style>
