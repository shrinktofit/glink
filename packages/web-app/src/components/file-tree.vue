<script setup lang="ts" generic="T extends FileTreeEntry">
import { computed, ref } from 'vue';
import type { FileTreeEntry } from './file-tree';

const props = withDefaults(defineProps<{
  items: readonly T[];
  compactFolders?: boolean;
}>(), { compactFolders: true });
const selected = defineModel<string>();
const emit = defineEmits<{ select: [item: T] }>();
const collapsed = ref(new Set<string>());

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
      if (!collapsed.value.has(node.path)) {
        append(node.children, depth + 1);
      }
    }
  }

  append(root, 0);
  return result;
});

function select(node: TreeNode) {
  if (node.children.size) {
    if (collapsed.value.has(node.path)) {
      collapsed.value.delete(node.path);
    } else {
      collapsed.value.add(node.path);
    }
  } else if (node.item) {
    selected.value = node.path;
    emit('select', node.item);
  }
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
    if (node.children.size && collapsed.value.has(node.path)) {
      collapsed.value.delete(node.path);
    } else if (node.children.size) {
      target = index + 1;
    }
    break;
  case 'ArrowLeft':
    if (node.children.size && !collapsed.value.has(node.path)) {
      collapsed.value.add(node.path);
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
      :class="{ selected: selected === node.path }"
      :style="{ paddingLeft: `${0.5 + depth}em` }"
      @keydown="navigate($event, index)"
    >
      <button
        class="entry"
        type="button"
        role="treeitem"
        :aria-level="depth + 1"
        :aria-expanded="node.children.size ? !collapsed.has(node.path) : undefined"
        :aria-selected="!node.children.size ? selected === node.path : undefined"
        :title="node.path"
        @click="select(node)"
      >
        <span
          v-if="node.children.size"
          class="chevron"
          aria-hidden="true"
        >
          {{ collapsed.has(node.path) ? '›' : '⌄' }}
        </span>
        <slot
          v-else
          name="prefix"
          :item="node.item!"
        />
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
  &:hover { background: var(--hover); }
  &.selected { background: var(--selected); }
}
.entry {
  appearance: none;
  border: 0;
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
}
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chevron { width: 0.85em; flex-shrink: 0; color: var(--muted); text-align: center; }
</style>
