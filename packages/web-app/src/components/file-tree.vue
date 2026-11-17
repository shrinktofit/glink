<script setup lang="ts" generic="T extends FileTreeEntry">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  useTemplateRef,
  watch,
  watchEffect,
} from 'vue';
import {
  buildFileTree,
  fileTreePathsOverlap,
  sortedFileTreeNodes,
  type FileTreeEntry,
  type FileTreeNode,
} from './file-tree';
import {
  createFileTreeSelection,
  fileTreeSelectionKey,
  fileTreeSelectionScopeKey,
  type FileTreeSelectionEntry,
} from './file-tree-selection';
import TreeDisclosure from './tree-disclosure.vue';
import { useExpansionState } from '../ui-state/use-expansion-state';

const props = withDefaults(defineProps<{
  items: readonly T[];
  compactFolders?: boolean;
  defaultExpanded?: boolean;
  disabledPaths?: readonly string[];
  stateKey?: string;
  dataReady?: boolean;
  revealSelection?: boolean;
  multiple?: boolean;
  selectionGroup?: string;
  selectionVisible?: boolean;
}>(), {
  compactFolders: true,
  defaultExpanded: true,
  disabledPaths: () => [],
  stateKey: undefined,
  dataReady: true,
  revealSelection: false,
  multiple: true,
  selectionGroup: undefined,
  selectionVisible: true,
});
// The default model is the previewed file, independent of the selected rows.
const currentFile = defineModel<string>();
const emit = defineEmits<{
  select: [item: T];
  selectionChange: [paths: readonly string[]];
  activate: [item: T];
  activateDirectory: [path: string];
  contextmenu: [event: MouseEvent, item: T, selection: readonly FileTreeSelectionEntry[]];
  directoryContextmenu: [
    event: MouseEvent,
    path: string,
    selection: readonly FileTreeSelectionEntry[],
  ];
}>();
const disabled = computed(() => new Set(props.disabledPaths));
const tree = useTemplateRef<HTMLElement>('tree');
const group = props.selectionGroup ?? '';
const sharedSelection = props.selectionGroup === undefined
  ? undefined
  : inject(fileTreeSelectionScopeKey);
if (props.selectionGroup !== undefined && !sharedSelection) {
  throw new Error('A selection group requires a FileTree selection scope.');
}
const selection = sharedSelection ?? createFileTreeSelection([group]);
const keyFor = (path: string) => fileTreeSelectionKey(group, path);
onBeforeUnmount(() => selection.removeGroup(group));

function isDisabled(path: string) {
  return disabled.value.has(path)
    || props.disabledPaths.some((pending) => fileTreePathsOverlap(path, pending));
}

type TreeNode = FileTreeNode<T>;
const root = computed(() => buildFileTree(props.items));

const orderedNodes = computed(() => {
  const nodes: TreeNode[] = [];

  function visit(children: Map<string, TreeNode>) {
    for (const node of sortedFileTreeNodes(children)) {
      nodes.push(node);
      visit(node.children);
    }
  }

  visit(root.value);
  return nodes;
});
const folderPaths = computed(() => orderedNodes.value.filter((node) => node.children.size)
  .map((node) => node.path));
const allPaths = computed(() => orderedNodes.value.map((node) => node.path));
const selectedPaths = computed(() => allPaths.value.filter((path) =>
  selection.state.selectedKeys.has(keyFor(path)),
));
watch(selectedPaths, (paths, previous) => {
  if (paths.length !== previous.length || paths.some((path) => !previous.includes(path))) {
    emit('selectionChange', paths);
  }
});
defineExpose({ selectedPaths });
const { isExpanded, setExpanded } = useExpansionState(
  () => props.stateKey,
  folderPaths,
  () => props.dataReady,
  () => props.defaultExpanded,
);

watch(currentFile, (path) => {
  if (sharedSelection || path === undefined) {
    return;
  }
  const key = keyFor(path);
  // A click updates selection before emitting the preview model. Its echo must not reset a range.
  if (key !== selection.state.current) {
    selection.state.replace(key);
  }
}, { immediate: true });

watch([currentFile, () => props.revealSelection], async ([path, reveal]) => {
  if (!path || !reveal) {
    return;
  }
  const segments = path.split('/');
  const ancestors = segments.slice(0, -1)
    .map((_segment, index) => segments.slice(0, index + 1).join('/'));
  if (ancestors.some((ancestor) => !isExpanded(ancestor))) {
    setExpanded(ancestors, true);
  }
  await nextTick();
  const entry = tree.value?.querySelector<HTMLElement>('[data-current="true"]');
  entry?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}, { immediate: true, flush: 'post' });

const rows = computed(() => {
  const result: Array<{
    node: TreeNode;
    name: string;
    depth: number;
    paths: string[];
    expanded: boolean;
  }> = [];

  function append(children: Map<string, TreeNode>, depth: number) {
    for (const start of sortedFileTreeNodes(children)) {
      let node = start;
      let name = node.name;
      const paths = [node.path];
      while (props.compactFolders && !node.item && node.children.size === 1) {
        const child = node.children.values().next().value!;
        if (child.item || !child.children.size) {
          break;
        }
        node = child;
        name += `/${node.name}`;
        paths.push(node.path);
      }
      const expanded = paths.every(isExpanded);
      result.push({
        node,
        name,
        depth,
        paths,
        expanded,
      });
      if (expanded) {
        append(node.children, depth + 1);
      }
    }
  }

  append(root.value, 0);
  return result;
});
const tabStopPath = computed(() => {
  const available = rows.value.filter((row) => !isDisabled(row.node.path));
  return available.find((row) => selection.state.current === keyFor(row.node.path))?.node.path
    ?? available[0]?.node.path;
});

watchEffect(() => {
  const visible = props.selectionVisible
    ? rows.value.filter((row) => !isDisabled(row.node.path)).map((row) => row.node.path)
    : [];
  selection.updateGroup(group, visible, allPaths.value, props.dataReady);
});

function preview(node: TreeNode) {
  if (!node.children.size && node.item) {
    currentFile.value = node.path;
    emit('select', node.item);
  }
}

function select(event: MouseEvent | KeyboardEvent, index: number) {
  const row = rows.value[index];
  const node = row.node;
  if (isDisabled(node.path)) {
    return;
  }
  if (!props.multiple && node.children.size) {
    setExpanded(row.paths, !row.expanded);
    return;
  }
  selection.state.select(keyFor(node.path), selection.visibleKeys.value, {
    additive: props.multiple && (event.ctrlKey || event.metaKey),
    range: props.multiple && event.shiftKey,
  });
  preview(node);
}

function toggle(event: MouseEvent, index: number) {
  const row = rows.value[index];
  if (!isDisabled(row.node.path)) {
    setExpanded(row.paths, !row.expanded);
    (event.currentTarget as HTMLElement).parentElement!.focus({ preventScroll: true });
  }
}

function contextMenu(event: MouseEvent, node: TreeNode) {
  if (isDisabled(node.path)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  selection.state.openContext(keyFor(node.path));
  preview(node);
  if (node.children.size) {
    emit('directoryContextmenu', event, node.path, selection.selectedEntries.value);
  } else if (node.item) {
    emit('contextmenu', event, node.item, selection.selectedEntries.value);
  }
}

function activate(event: MouseEvent, node: TreeNode) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey
    || isDisabled(node.path)) {
    return;
  }
  if (node.children.size) {
    emit('activateDirectory', node.path);
  } else if (node.item) {
    emit('activate', node.item);
  }
}

function navigate(event: KeyboardEvent, index: number) {
  // Action buttons have their own keyboard behavior.
  if (event.target !== event.currentTarget) {
    return;
  }
  const entries = tree.value!.querySelectorAll<HTMLElement>('.tree-row');
  const row = rows.value[index];
  const node = row.node;
  if (isDisabled(node.path)) {
    return;
  }
  const additive = event.ctrlKey || event.metaKey;
  if (props.multiple && additive && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    selection.state.selectAll(selection.visibleKeys.value);
    return;
  }
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    select(event, index);
    return;
  }
  let target = index;
  switch (event.key) {
  case 'ArrowDown':
    target = Math.min(index + 1, rows.value.length - 1);
    break;
  case 'ArrowUp':
    target = Math.max(index - 1, 0);
    break;
  case 'Home':
    target = 0;
    break;
  case 'End':
    target = rows.value.length - 1;
    break;
  case 'ArrowRight':
    if (node.children.size && !row.expanded) {
      setExpanded(row.paths, true);
    } else if (node.children.size) {
      target = index + 1;
    }
    break;
  case 'ArrowLeft':
    if (node.children.size && row.expanded) {
      setExpanded(row.paths, false);
    } else {
      let parentIndex = index - 1;
      while (parentIndex >= 0 && rows.value[parentIndex].depth >= rows.value[index].depth) {
        parentIndex--;
      }
      if (parentIndex >= 0) {
        target = parentIndex;
      }
    }
    break;
  default: return;
  }
  event.preventDefault();
  const direction = ['ArrowUp', 'ArrowLeft', 'End'].includes(event.key) ? -1 : 1;
  while (rows.value[target] && isDisabled(rows.value[target].node.path)) {
    target += direction;
  }
  const targetRow = rows.value[target];
  if (targetRow && target !== index) {
    entries[target]?.focus();
    if ((!additive || event.shiftKey) && (props.multiple || !targetRow.node.children.size)) {
      select(event, target);
    }
  }
}
</script>

<template>
  <div
    ref="tree"
    class="file-tree"
    role="tree"
    :aria-multiselectable="multiple"
  >
    <div
      v-for="({ node, name, depth, expanded }, index) in rows"
      :key="node.path"
      class="tree-row"
      :class="{
        selected: selection.state.selectedKeys.has(keyFor(node.path)),
        disabled: isDisabled(node.path),
      }"
      :style="{ paddingLeft: `${0.5 + depth}em` }"
      role="treeitem"
      :tabindex="node.path === tabStopPath ? 0 : -1"
      :aria-disabled="isDisabled(node.path) || undefined"
      :aria-level="depth + 1"
      :aria-expanded="node.children.size ? expanded : undefined"
      :aria-selected="selection.state.selectedKeys.has(keyFor(node.path))"
      :data-current="selection.state.current === keyFor(node.path)"
      :title="node.path"
      @click="select($event, index)"
      @dblclick="activate($event, node)"
      @keydown="navigate($event, index)"
      @contextmenu="contextMenu($event, node)"
    >
      <button
        v-if="node.children.size"
        class="prefix disclosure"
        type="button"
        tabindex="-1"
        :disabled="isDisabled(node.path)"
        :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${node.path}`"
        @click.stop="toggle($event, index)"
        @dblclick.stop
      >
        <tree-disclosure :expanded="expanded" />
      </button>
      <span
        v-else
        class="prefix"
      >
        <slot
          name="prefix"
          :item="node.item!"
        />
      </span>
      <span class="name">{{ name }}</span>
      <span
        v-if="node.item && $slots.actions"
        class="actions"
        @click.stop
        @dblclick.stop
        @contextmenu.stop.prevent
      >
        <slot
          name="actions"
          :item="node.item"
        />
      </span>
    </div>
  </div>
</template>

<style scoped lang="less">
.file-tree { padding: 0.25em 0; font-size: 0.875rem; line-height: 1.6em; }
.tree-row {
  display: flex;
  align-items: center;
  gap: 0.5em;
  min-height: 1.6em;
  padding-right: 0.5em;
  cursor: pointer;
  user-select: none;
  &:hover:not(.disabled) { background: var(--hover); }
  &.selected { background: var(--selected); }
  &.disabled { opacity: 0.5; cursor: wait; }
  &:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
}
.disclosure {
  appearance: none;
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  color: inherit;
  &:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  &:disabled { cursor: wait; }
}
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; flex-shrink: 0; }
.prefix {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  flex: 0 0 1em;
}
</style>
