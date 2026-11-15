<script setup lang="ts">
import GitWorktreePanel from './git-worktree-panel.vue';
defineProps<{ worktreePath: string }>();
</script>
<template>
  <main class="repository-page">
    <git-worktree-panel :worktree-path="worktreePath" />
  </main>
</template>
<style scoped lang="less">
.repository-page {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.repository-page :deep(.repository-view) {
  height: 100%;
}
</style>
