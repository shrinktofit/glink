<script setup lang="ts">
import { computed } from 'vue';
import type { WorkspaceCommit, WorkspaceDocument } from '@glink/protocol/workspace';
const props = defineProps<{ workspace: WorkspaceDocument; commits: WorkspaceCommit[] }>();
const selected = defineModel<WorkspaceCommit>();
const rowHeight = 28;
const lanes = computed(
  () =>
    new Map(
      [...new Set(props.commits.map((commit) => commit.projectId))].map((id, index) => [id, index]),
    ),
);
const width = computed(() => Math.max(34, lanes.value.size * 14 + 14));
const links = computed(() =>
  props.commits.flatMap((commit, row) =>
    commit.parents.flatMap((parent) => {
      const target = props.commits.findIndex(
        (item) => item.projectId === commit.projectId && item.sha === parent,
      );
      const x = 12 + lanes.value.get(commit.projectId)! * 14;
      return target < 0
        ? []
        : [
          {
            key: `${commit.projectId}:${commit.sha}:${parent}`,
            x,
            y: row * rowHeight + 14,
            end: target * rowHeight + 14,
          },
        ];
    }),
  ),
);
</script>
<template>
  <div
    class="history-log"
    aria-label="Workspace commits"
  >
    <div
      v-if="commits.length"
      class="log-canvas"
      :style="{ minHeight: `${commits.length * rowHeight}px` }"
    >
      <svg
        class="graph"
        :width="width"
        :height="commits.length * rowHeight"
        aria-hidden="true"
      >
        <line
          v-for="link in links"
          :key="link.key"
          :x1="link.x"
          :x2="link.x"
          :y1="link.y"
          :y2="link.end"
          stroke="var(--ws-blue)"
          stroke-width="1.5"
        />
        <circle
          v-for="(commit, row) in commits"
          :key="`${commit.projectId}:${commit.sha}`"
          :cx="12 + lanes.get(commit.projectId)! * 14"
          :cy="row * rowHeight + 14"
          r="3"
          fill="var(--ws-blue)"
        />
      </svg>
      <button
        v-for="commit in commits"
        :key="`${commit.projectId}:${commit.sha}`"
        class="commit-row"
        :class="{
          selected: selected?.projectId === commit.projectId && selected.sha === commit.sha,
        }"
        :style="{ paddingLeft: `${width}px`, height: `${rowHeight}px` }"
        @click="selected = commit"
      >
        <span class="project-label">{{
          workspace.projects.find((project) => project.id === commit.projectId)?.name
        }}</span>
        <span class="subject">{{ commit.subject }}</span>
        <span class="author muted">{{ commit.author }}</span>
        <code class="muted">{{ commit.sha.slice(0, 7) }}</code>
      </button>
    </div>
    <p
      v-else
      class="ws-empty"
    >
      基础提交与 HEAD 之间没有提交
    </p>
  </div>
</template>
<style scoped lang="less">
.history-log {
  height: 100%;
  overflow: auto;
  min-height: 0;
  border-bottom: 1px solid var(--ws-line);
}
.log-canvas {
  position: relative;
  min-width: 42em;
}
.graph {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 1;
}
.commit-row {
  display: flex;
  align-items: center;
  gap: 0.8em;
  width: 100%;
  text-align: left;
  border-radius: 0;
  padding-right: 0.8em;
}
.commit-row.selected {
  background: var(--ws-active);
}
.project-label {
  background: var(--ws-side);
  border: 1px solid var(--ws-line);
  border-radius: 0.35em;
  font-size: 0.8em;
  padding: 0 0.4em;
  width: 11em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.subject {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.author {
  font-size: 0.85em;
  max-width: 9em;
  overflow: hidden;
  white-space: nowrap;
}
code {
  font:
    0.85em Consolas,
    monospace;
}
</style>
