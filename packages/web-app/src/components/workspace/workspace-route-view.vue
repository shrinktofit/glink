<script setup lang="ts">
import { inject, onWatcherCleanup, ref, shallowRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { WorkspaceDocument } from '@glink/protocol/workspace';
import { appKey } from '../../app-context';
import { RouteName } from '../../router';
import WorkspacePage from './workspace-page.vue';

const props = defineProps<{ name: string }>();
const app = inject(appKey)!;
const workspace = shallowRef<WorkspaceDocument>();
const loading = ref(false);
const error = ref('');

watch(
  () => props.name,
  async (name) => {
    const controller = new AbortController();
    onWatcherCleanup(() => controller.abort());
    workspace.value = undefined;
    error.value = '';
    loading.value = true;
    try {
      await app.refreshCatalog(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      const matches = app.catalog.value!.workspaces.filter((entry) => entry.name === name);
      if (matches.length !== 1) {
        error.value = matches.length
          ? '工作区名称重复，无法确定要打开的工作区。'
          : `找不到工作区“${name}”。`;
        return;
      }
      const document = await app.workspaceService.get(matches[0].id, controller.signal);
      if (!controller.signal.aborted) {
        workspace.value = document;
      }
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (!controller.signal.aborted) {
        loading.value = false;
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <workspace-page
    v-if="workspace"
    :key="workspace.id"
    v-model="workspace"
  />
  <main
    v-else
    class="route-state ws-panel"
  >
    <p
      v-if="loading"
      class="muted"
      role="status"
    >
      正在打开工作区…
    </p>
    <template v-else>
      <p
        class="ws-error"
        role="alert"
      >
        {{ error }}
      </p>
      <router-link
        class="ws-button"
        :to="{ name: RouteName.starter }"
      >返回开始页面</router-link>
    </template>
  </main>
</template>

<style scoped lang="less">
.route-state {
  flex: 1;
  display: grid;
  place-content: center;
  gap: 1em;
  text-align: center;
  padding: 2em;
}
a {
  color: var(--ws-blue);
  text-decoration: none;
  justify-self: center;
}
</style>
