<script setup lang="ts" generic="T extends FileTreeEntry">
import { computed, ref } from 'vue';
import type { FileTreeEntry } from './file-tree';
import TreeDisclosure from './tree-disclosure.vue';

const props = withDefaults(defineProps<{
  items: readonly T[];
  compactFolders?: boolean;
  defaultExpanded?: boolean;
  disabledPaths?: readonly string[];
}>(), {
  compactFolders: true,
  defaultExpanded: true,
  disabledPaths: () => [],
});
const selected = defineModel<string>();
const emit = defineEmits<{
  select: [item: T];
  activate: [item: T];
  contextmenu: [event: MouseEvent, item: T];
}>();
const expanded = ref(new Map<string, boolean>());
const disabled = computed(() => new Set(props.disabledPaths));

function isExpanded(path: string) {
  return expanded.value.get(path) ?? props.defaultExpanded;
}

interface TreeNode {
  path: string;
  name: string;
  children: Map<string, TreeNode>;
  item?: T;
}

const rows = computed(() => {
  const root = new Map<string, TreeNode>();
  for (const item of props.items) {
    let children = root;
    const segments = item.path.split('/');
    segments.forEach((name, index) => {
      let node = children.get(name);
      if (!node) {
        node = { path: segments.slice(0, index + 1).join('/'), name, children: new Map() };
        children.set(name, node);
      }
      if (index === segments.length - 1) {
        node.item = item;
      }
      children = node.children;
    });
  }
  const result: Array<{ node: TreeNode; name: string; depth: number }> = [];

  function append(children: Map<string, TreeNode>, depth: number) {
    const nodes = [...children.values()].sort((a, b) => {
      return Number(!a.children.size) - Number(!b.children.size) || a.name.localeCompare(b.name);
    });
    for (const start of nodes) {
      let node = start;
      let name = node.name;
      while (props.compactFolders && !node.item && node.children.size === 1) {
        const child = node.children.values().next().value!;
        if (child.item || !child.children.size) {
          break;
        }
        node = child;
        name += `/${node.name}`;
      }
      result.push({ node, name, depth });
      if (isExpanded(node.path)) {
        append(node.children, depth + 1);
      }
    }
  }

  append(root, 0);
  return result;
});

function select(node: TreeNode) {
  if (disabled.value.has(node.path)) {
    return;
  }
  if (node.children.size) {
    expanded.value.set(node.path, !isExpanded(node.path));
  } else if (node.item) {
    selected.value = node.path;
    emit('select', node.item);
  }
}

function contextMenu(event: MouseEvent, node: TreeNode) {
  if (disabled.value.has(node.path)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!node.item) {
    return;
  }
  emit('contextmenu', event, node.item);
}

function navigate(event: KeyboardEvent, index: number) {
  const tree = (event.currentTarget as HTMLElement).parentElement!;
  const buttons = tree.querySelectorAll<HTMLButtonElement>('.entry');
  const node = rows.value[index].node;
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
    if (node.children.size && !isExpanded(node.path)) {
      expanded.value.set(node.path, true);
    } else if (node.children.size) {
      target = index + 1;
    }
    break;
  case 'ArrowLeft':
    if (node.children.size && isExpanded(node.path)) {
      expanded.value.set(node.path, false);
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
  while (buttons[target]?.disabled) {
    target += direction;
  }
  buttons[target]?.focus();
}
</script>

<template>
  <div
    class="file-tree"
    role="tree"
  >
    <div
      v-for="({ node, name, depth }, index) in rows"
      :key="node.path"
      class="tree-row"
      :class="{ selected: selected === node.path, disabled: disabled.has(node.path) }"
      :style="{ paddingLeft: `${0.5 + depth}em` }"
      @keydown="navigate($event, index)"
      @contextmenu="contextMenu($event, node)"
    >
      <button
        class="entry"
        type="button"
        role="treeitem"
        :disabled="disabled.has(node.path)"
        :aria-disabled="disabled.has(node.path) || undefined"
        :aria-level="depth + 1"
        :aria-expanded="node.children.size ? isExpanded(node.path) : undefined"
        :aria-selected="!node.children.size ? selected === node.path : undefined"
        :title="node.path"
        @click="select(node)"
        @dblclick="
          node.item && !disabled.has(node.path)
            && $event.button === 0 && emit('activate', node.item)
        "
      >
        <span class="prefix">
          <tree-disclosure
            v-if="node.children.size"
            :expanded="isExpanded(node.path)"
          />
          <slot
            v-else
            name="prefix"
            :item="node.item!"
          />
        </span>
        <span class="name">{{ name }}</span>
      </button>
      <slot
        v-if="node.item"
        name="actions"
        :item="node.item"
      />
    </div>
  </div>
</template>

<style scoped lang="less">
.file-tree { padding: 0.25em 0; font-size: 0.875rem; line-height: 1.6em; }
.tree-row {
  display: flex;
  align-items: center;
  min-height: 1.6em;
  padding-right: 0.5em;
  &:hover:not(.disabled) { background: var(--hover); }
  &.selected { background: var(--selected); }
  &.disabled { opacity: 0.5; cursor: wait; }
}
.entry {
  appearance: none;
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5em;
  flex: 1;
  min-width: 0;
  height: 1.6em;
  color: inherit;
  text-align: left;
  &:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  &:disabled { cursor: wait; }
}
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prefix {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  flex: 0 0 1em;
}
</style>
