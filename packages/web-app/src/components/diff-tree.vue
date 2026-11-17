<script setup lang="ts">
import { GitDiffType, GitIndexAction, type GitFileChange } from '@glink/protocol/git';
import { computed, ref, watch } from 'vue';
import FileTree from './file-tree.vue';
import { fileTreePathsOverlap } from './file-tree';
import GitFileContextMenu from './git/git-file-context-menu.vue';
defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  items: readonly GitFileChange[];
  repoPath: string;
  compactFolders?: boolean;
  disabledPaths?: readonly string[];
  stateKey?: string;
  dataReady?: boolean;
  revealSelection?: boolean;
  indexAction?: GitIndexAction;
  indexDisabled?: boolean;
}>(), {
  compactFolders: true,
  disabledPaths: () => [],
  stateKey: undefined,
  dataReady: true,
  revealSelection: false,
  indexAction: undefined,
  indexDisabled: false,
});
const selected = defineModel<string>();
const emit = defineEmits<{
  select: [item: GitFileChange];
  activate: [item: GitFileChange];
  indexDirectory: [path: string];
}>();
const context = ref<{
  path: string;
  directory: boolean;
  x: number;
  y: number;
}>();
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

const contextIndexDisabled = computed(() =>
  !context.value || !canIndexDirectory(context.value.path),
);

function indexDirectory(path: string) {
  if (canIndexDirectory(path)) {
    context.value = undefined;
    emit('indexDirectory', path);
  }
}

function openMenu(event: MouseEvent, path: string, directory: boolean) {
  event.preventDefault();
  event.stopPropagation();
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  context.value = {
    path,
    directory,
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
    @select="emit('select', $event)"
    @activate="emit('activate', $event)"
    @activate-directory="indexDirectory"
    @contextmenu="(event, item) => openMenu(event, item.path, false)"
    @directory-contextmenu="(event, path) => openMenu(event, path, true)"
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
    :index-action="context.directory ? indexAction : undefined"
    :index-disabled="contextIndexDisabled"
    @index="indexDirectory(context.path)"
    @close="context = undefined"
  />
</template>

<style scoped lang="less">
.diff-marker { width: 12px; flex-shrink: 0; text-align: center; font: 11px Consolas, monospace; }
</style>
