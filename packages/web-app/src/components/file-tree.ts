export interface FileTreeEntry {
  path: string;
}

export interface FileTreeNode<T extends FileTreeEntry> {
  path: string;
  name: string;
  children: Map<string, FileTreeNode<T>>;
  item?: T;
}

export function buildFileTree<T extends FileTreeEntry>(items: readonly T[]) {
  const root = new Map<string, FileTreeNode<T>>();
  for (const item of items) {
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
  return root;
}

export function sortedFileTreeNodes<T extends FileTreeEntry>(
  children: ReadonlyMap<string, FileTreeNode<T>>,
) {
  return [...children.values()].sort((first, second) =>
    Number(!first.children.size) - Number(!second.children.size)
    || first.name.localeCompare(second.name),
  );
}

/** Full leaf order is independent of folder compaction and expansion state. */
export function fileTreeItemsInOrder<T extends FileTreeEntry>(items: readonly T[]) {
  const result: T[] = [];

  function append(children: ReadonlyMap<string, FileTreeNode<T>>) {
    for (const node of sortedFileTreeNodes(children)) {
      if (node.children.size) {
        append(node.children);
      } else if (node.item) {
        result.push(node.item);
      }
    }
  }

  append(buildFileTree(items));
  return result;
}

export function fileTreePathsOverlap(first: string, second: string) {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}
