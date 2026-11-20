<script lang="ts">
export enum WorktreeState {
  loading = 'loading',
  clean = 'clean',
  modified = 'modified',
  unavailable = 'unavailable',
}
</script>

<script setup lang="ts">
defineProps<{ state: WorktreeState }>();

const labels: Record<WorktreeState, string> = {
  [WorktreeState.loading]: '正在读取工作树状态',
  [WorktreeState.clean]: 'Clean',
  [WorktreeState.modified]: '有未提交修改',
  [WorktreeState.unavailable]: '工作树状态不可用',
};
</script>

<template>
  <svg
    class="worktree-state-icon"
    :class="state"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    :aria-label="labels[state]"
    focusable="false"
  >
    <circle
      v-if="state === WorktreeState.loading"
      class="spinner"
      cx="12"
      cy="12"
      r="8"
      stroke-dasharray="34 17"
    />
    <circle
      v-else-if="state === WorktreeState.clean"
      cx="12"
      cy="12"
      r="2.5"
      stroke-width="1.25"
    />
    <template v-else>
      <path
        :d="state === WorktreeState.modified
          ? 'M10 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v4'
          : 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z'"
      />
      <path d="M14 2v6h6" />
      <path
        v-if="state === WorktreeState.modified"
        class="pencil"
        d="m14 18 6-6 3 3-6 6-4 1 1-4Zm4-4 3 3"
      />
      <template v-else-if="state === WorktreeState.unavailable">
        <path d="M12 12v4" />
        <circle
          cx="12"
          cy="19"
          r="0.5"
          fill="currentColor"
          stroke="none"
        />
      </template>
    </template>
  </svg>
</template>

<style scoped lang="less">
.worktree-state-icon {
  display: inline-block;
  flex: 0 0 1.4em;
  width: 1.4em;
  height: 1.5em;
  vertical-align: middle;
}
.loading,
.clean { color: var(--ws-muted); }
.modified { color: var(--ws-orange); }
.unavailable { color: var(--ws-red); }
.spinner {
  transform-origin: center;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
}
</style>
