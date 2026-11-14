<script setup lang="ts">
import { GitDiffType, type GitFileChange } from '@glink/protocol/git';
import FileTree from './file-tree.vue';

withDefaults(defineProps<{
  items: readonly GitFileChange[];
  compactFolders?: boolean;
}>(), { compactFolders: true });
const selected = defineModel<string>();
const emit = defineEmits<{ select: [item: GitFileChange] }>();
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
    v-model="selected"
    :items="items"
    :compact-folders="compactFolders"
    @select="emit('select', $event)"
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
</template>

<style scoped lang="less">
.diff-marker { width: 12px; flex-shrink: 0; text-align: center; font: 11px Consolas, monospace; }
</style>
