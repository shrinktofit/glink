<script setup lang="ts">
import { GitDiffType, type GitFileChange } from '@glink/protocol/git';
import { ref, watch } from 'vue';
import FileTree from './file-tree.vue';
import GitFileContextMenu from './git/git-file-context-menu.vue';
defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  items: readonly GitFileChange[];
  repoPath: string;
  compactFolders?: boolean;
  disabledPaths?: readonly string[];
}>(), { compactFolders: true, disabledPaths: () => [] });
const selected = defineModel<string>();
const emit = defineEmits<{ select: [item: GitFileChange]; activate: [item: GitFileChange] }>();
const context = ref<{ path: string; x: number; y: number }>();
watch(() => props.disabledPaths, (paths) => {
  if (context.value && paths.includes(context.value.path)) {
    context.value = undefined;
  }
});

function openMenu(event: MouseEvent, item: GitFileChange) {
  event.preventDefault();
  event.stopPropagation();
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  context.value = { path: item.path,
    x: event.clientX || bounds.left,
    y: event.clientY || bounds.bottom };
}

const markers: Record<GitDiffType, { icon: string; label: string; color: string }> = {
  [GitDiffType.added]: { icon: '+', label: 'Added', color: 'var(--added)' },
  [GitDiffType.untracked]: { icon: '+', label: 'Untracked', color: 'var(--added)' },
  [GitDiffType.deleted]: { icon: '−', label: 'Deleted', color: 'var(--deleted)' },
  [GitDiffType.modified]: { icon: 'M', label: 'Modified', color: 'var(--modified)' },
  [GitDiffType.renamed]: { icon: 'M', label: 'Renamed', color: 'var(--accent)' },
  [GitDiffType.copied]: { icon: '+', label: 'Copied', color: 'var(--added)' },
  [GitDiffType.typeChanged]: { icon: 'M', label: 'Type changed', color: 'var(--modified)' },
  [GitDiffType.unmerged]: { icon: '!', label: 'Conflict', color: 'var(--deleted)' },
};
</script>

<template>
  <file-tree
    v-bind="$attrs"
    v-model="selected"
    :items="items"
    :compact-folders="compactFolders"
    :disabled-paths="disabledPaths"
    @select="emit('select', $event)"
    @activate="emit('activate', $event)"
    @contextmenu="openMenu"
  >
    <template #prefix="{ item }">
      <span
        class="diff-marker"
        :style="{ color: markers[item.type].color }"
        :title="markers[item.type].label"
        :aria-label="markers[item.type].label"
      >{{ markers[item.type].icon }}</span>
    </template>
    <template #actions="{ item }">
      <slot
        name="actions"
        :item="item"
      />
    </template>
  </file-tree>
  <git-file-context-menu
    v-if="context"
    :path="context.path"
    :repo-path="repoPath"
    :x="context.x"
    :y="context.y"
    @close="context = undefined"
  />
</template>

<style scoped lang="less">
.diff-marker { width: 12px; flex-shrink: 0; text-align: center; font: 11px Consolas, monospace; }
</style>
