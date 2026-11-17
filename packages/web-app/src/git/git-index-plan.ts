import { GitIndexAction } from '@glink/protocol/git';
import { fileTreeItemsInOrder } from '../components/file-tree';
import type { FileTreeSelectionEntry } from '../components/file-tree-selection';
import type { GitChangeGroup } from './git-change-group';
import type { GitIndexBatch } from './git-index-target';

/** Expand selected folders against source changes, once per file and per worktree. */
export function planGitIndexSelection(
  groups: readonly GitChangeGroup[],
  selection: readonly FileTreeSelectionEntry[],
  action: GitIndexAction,
): GitIndexBatch[] {
  return groups.flatMap((group) => {
    const selected = selection.filter((entry) => entry.group === group.id);
    const paths = fileTreeItemsInOrder(group.files).filter((file) =>
      (action === GitIndexAction.unstage || !file.stageBlockedReason)
      && selected.some((entry) => file.path === entry.path
        || file.path.startsWith(`${entry.path}/`)),
    ).map((file) => file.path);
    return paths.length ? [{ group: group.id, paths }] : [];
  });
}
