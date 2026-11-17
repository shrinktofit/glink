<script setup lang="ts">
import { computed } from 'vue';
import {
  WorkspaceConnectionKind,
  type WorkspaceDocument,
  type WorkspaceProjectStatus,
} from '@glink/protocol/workspace';
const props = defineProps<{ workspace: WorkspaceDocument;
  selected: readonly string[];
  statuses: WorkspaceProjectStatus[]; }>();
const emit = defineEmits<{ select: [id: string, event: MouseEvent]; edit: [id: string] }>();

function liveState(id: string) {
  const status = props.statuses.find((item) => item.projectId === id);
  if (!status) {
    return '…';
  }
  if (status.error) {
    return 'Unavailable';
  }
  return status.staged.length || status.unstaged.length ? '● Not clean' : '○ Clean';
}

const layout = computed(() => {
  const depth = new Map(props.workspace.projects.map((project) => [project.id, 0]));
  let round = props.workspace.projects.length;
  while (round-- > 0) {
    for (const edge of props.workspace.connections) {
      depth.set(edge.to, Math.max(depth.get(edge.to)!, depth.get(edge.from)! + 1));
    }
  }
  const rows = new Map<number, number>();
  return props.workspace.projects.map((project) => {
    const level = depth.get(project.id)!;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return { ...project, x: 18 + level * 210, y: 20 + row * 122 };
  });
});
const width = computed(() => Math.max(420, ...layout.value.map((node) => node.x + 200)));
const height = computed(() => Math.max(240, ...layout.value.map((node) => node.y + 116)));

function edgePath(from: string, to: string) {
  const a = layout.value.find((node) => node.id === from)!;
  const b = layout.value.find((node) => node.id === to)!;
  return `M${a.x + 180},${a.y + 44} C${a.x + 198},${a.y + 44} ${b.x - 18},${b.y + 44} ${b.x},${b.y + 44}`;
}
</script>
<template>
  <section
    class="graph-scroll"
    aria-label="Project Graph"
  >
    <div
      class="graph-canvas"
      :style="{ width: `${width}px`, height: `${height}px` }"
    >
      <svg
        :width="width"
        :height="height"
        aria-hidden="true"
      >
        <path
          v-for="edge in workspace.connections"
          :key="`${edge.from}:${edge.to}`"
          :d="edgePath(edge.from, edge.to)"
          fill="none"
          :stroke="
            edge.kind === WorkspaceConnectionKind.submodule ? 'var(--ws-green)' : 'var(--ws-blue)'
          "
          :stroke-dasharray="edge.kind === WorkspaceConnectionKind.manual ? '4 3' : undefined"
          stroke-width="1.5"
        />
      </svg>
      <div
        v-for="node in layout"
        :key="node.id"
        class="node"
        :class="{ selected: selected.includes(node.id) }"
        :style="{ left: `${node.x}px`, top: `${node.y}px` }"
      >
        <button
          class="node-pick"
          :title="node.worktreePath"
          :aria-pressed="selected.includes(node.id)"
          @click="emit('select', node.id, $event)"
        >
          <strong>{{ node.name }}</strong>
          <small>{{ liveState(node.id) }}</small>
          <span>{{
            node.binding.revision.replace(/^refs\/(heads|remotes|tags)\//, '').slice(0, 28)
          }}</span>
          <small :class="{ settled: node.settled }">{{
            node.settled ? '✓ Settled' : '○ Unsettled'
          }}</small>
        </button><button
          class="edit ws-icon"
          :aria-label="`编辑 ${node.name}`"
          @click="emit('edit', node.id)"
        >
          ⋯
        </button>
      </div>
    </div>
  </section>
</template>
<style scoped lang="less">
.graph-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.graph-canvas {
  position: relative;
}
svg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.node {
  position: absolute;
  width: 180px;
  min-height: 88px;
  background: var(--ws-surface);
  border: 1px solid var(--ws-line);
  border-radius: 0.6em;
}
.node.selected {
  border-color: var(--ws-blue);
  box-shadow: 0 0 0 1px var(--ws-blue);
}
.node-pick {
  display: flex;
  flex-direction: column;
  gap: 0.35em;
  text-align: left;
  width: 100%;
  padding: 0.8em;
}
strong {
  font-size: 0.95em;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
span,
small {
  color: var(--ws-muted);
  font-size: 0.8em;
  overflow: hidden;
  max-width: 100%;
}
.settled {
  color: var(--ws-green);
}
.edit {
  position: absolute;
  right: 0.2em;
  top: 0.2em;
}
</style>
