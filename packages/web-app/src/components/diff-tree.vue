<script setup lang="ts">
import { GitDiffType, GitIndexAction, type GitFileChange } from '@glink/protocol/git';
import { computed, ref, watch } from 'vue';
import FileTree from './file-tree.vue';
import { fileTreePathsOverlap } from './file-tree';
import type { FileTreeSelectionEntry } from './file-tree-selection';
import type { GitChangeGroup } from '../git/git-change-group';
import type { GitIndexBatch } from '../git/git-index-target';
import { planGitIndexSelection } from '../git/git-index-plan';
import GitFileContextMenu from './git/git-file-context-menu.vue';
defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  items: readonly GitFileChange[];
  repoPath: string;
  changeGroups?: readonly GitChangeGroup[];
  compactFolders?: boolean;
  disabledPaths?: readonly string[];
  stateKey?: string;
  dataReady?: boolean;
  revealSelection?: boolean;
  multiple?: boolean;
  selectionGroup?: string;
  selectionVisible?: boolean;
  indexAction?: GitIndexAction;
  indexDisabled?: boolean;
}>(), {
  compactFolders: true,
  changeGroups: undefined,
  disabledPaths: () => [],
  stateKey: undefined,
  dataReady: true,
  revealSelection: false,
  multiple: true,
  selectionGroup: undefined,
  selectionVisible: true,
  indexAction: undefined,
  indexDisabled: false,
});
const selected = defineModel<string>();
const emit = defineEmits<{
  select: [item: GitFileChange];
  selectionChange: [paths: readonly string[]];
  activate: [item: GitFileChange];
  indexDirectory: [path: string];
  indexSelection: [batches: readonly GitIndexBatch[]];
}>();
const context = ref<{
  path: string;
  selection: readonly FileTreeSelectionEntry[];
  paths: ReadonlyArray<{ path: string; repoPath: string }>;
  x: number;
  y: number;
}>();
const changeGroups = computed(() => props.changeGroups ?? [{
  id: props.selectionGroup ?? '',
  repoPath: props.repoPath,
  files: props.items,
}]);
watch(() => props.disabledPaths, (paths) => {
  if (context.value && paths.some((path) => fileTreePathsOverlap(path, context.value!.path))) {
    context.value = undefined;
  }
});

function canIndexDirectory(path: string) {
  return !!props.indexAction && !props.indexDisabled
    && !props.disabledPaths.some((pending) => fileTreePathsOverlap(path, pending))
    && props.items.some((file) => file.path.startsWith(`${path}/`)
      && (props.indexAction === GitIndexAction.unstage || !file.stageBlockedReason));
}

const indexBatches = computed(() => context.value && props.indexAction
  ? planGitIndexSelection(changeGroups.value, context.value.selection, props.indexAction)
  : []);
const contextIndexDisabled = computed(() => props.indexDisabled || !indexBatches.value.length);

function indexSelection() {
  if (contextIndexDisabled.value) {
    return;
  }
  const batches = indexBatches.value;
  context.value = undefined;
  emit('indexSelection', batches);
}

function indexDirectory(path: string) {
  if (canIndexDirectory(path)) {
    context.value = undefined;
    emit('indexDirectory', path);
  }
}

function openMenu(
  event: MouseEvent,
  path: string,
  selection: readonly FileTreeSelectionEntry[],
) {
  event.preventDefault();
  event.stopPropagation();
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  context.value = {
    path,
    selection,
    paths: selection.map((entry) => ({
      path: entry.path,
      repoPath: changeGroups.value.find((group) => group.id === entry.group)!.repoPath,
    })),
    x: event.clientX || bounds.left,
    y: event.clientY || bounds.bottom,
  };
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
    :state-key="stateKey"
    :data-ready="dataReady"
    :reveal-selection="revealSelection"
    :multiple="multiple"
    :selection-group="selectionGroup"
    :selection-visible="selectionVisible"
    @select="emit('select', $event)"
    @selection-change="emit('selectionChange', $event)"
    @activate="emit('activate', $event)"
    @activate-directory="indexDirectory"
    @contextmenu="(event, item, selection) => openMenu(event, item.path, selection)"
    @directory-contextmenu="openMenu"
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
    :paths="context.paths"
    :x="context.x"
    :y="context.y"
    :index-action="indexAction"
    :index-disabled="contextIndexDisabled"
    @index="indexSelection"
    @close="context = undefined"
  />
</template>

<style scoped lang="less">
.diff-marker { width: 12px; flex-shrink: 0; text-align: center; font: 11px Consolas, monospace; }
</style>
