import {
  computed,
  reactive,
  shallowReactive,
  toValue,
  watch,
  type InjectionKey,
  type MaybeRefOrGetter,
} from 'vue';
import { TreeSelection } from './tree-selection';

interface SelectionGroup {
  visibleKeys: readonly string[];
  allPaths: readonly string[];
}

export interface FileTreeSelectionEntry {
  group: string;
  path: string;
}

export function fileTreeSelectionKey(group: string, path: string) {
  return JSON.stringify([group, path]);
}

/** A scope can span several project trees, in the same order as their headers. */
export function createFileTreeSelection(groupOrder: MaybeRefOrGetter<readonly string[]>) {
  const state = reactive(new TreeSelection());
  const groups = shallowReactive(new Map<string, SelectionGroup>());
  const visibleKeys = computed(() => toValue(groupOrder)
    .flatMap((id) => groups.get(id)?.visibleKeys ?? []));
  const selectedEntries = computed(() => toValue(groupOrder).flatMap((id) => {
    const paths = groups.get(id)?.allPaths ?? [];
    return paths.filter((path) => state.selectedKeys.has(fileTreeSelectionKey(id, path)))
      .map((path): FileTreeSelectionEntry => ({ group: id, path }));
  }));

  watch(() => toValue(groupOrder).flatMap((id) =>
    (groups.get(id)?.allPaths ?? []).map((path) => fileTreeSelectionKey(id, path))), (keys) => {
    state.retain(new Set(keys));
  }, { flush: 'post' });

  function updateGroup(
    id: string,
    visible: readonly string[],
    all: readonly string[],
    ready: boolean,
  ) {
    groups.set(id, {
      visibleKeys: visible.map((path) => fileTreeSelectionKey(id, path)),
      // An incomplete refresh is not evidence that a selected file has disappeared.
      allPaths: ready ? all : groups.get(id)?.allPaths ?? [],
    });
  }

  function removeGroup(id: string) {
    groups.delete(id);
  }

  return {
    state,
    visibleKeys,
    selectedEntries,
    updateGroup,
    removeGroup,
  };
}

export type FileTreeSelectionScope = ReturnType<typeof createFileTreeSelection>;

export const fileTreeSelectionScopeKey: InjectionKey<FileTreeSelectionScope>
  = Symbol('file-tree-selection');
