import { GitIndexAction, type GitFileChange } from '@glink/protocol/git';
import { fileTreeItemsInOrder } from '../components/file-tree';
import { GitIndexScope, type GitIndexTarget } from './git-index-target';

export interface GitChangeEntry {
  worktreePath: string;
  file: GitFileChange;
}

export function orderGitChanges(
  groups: ReadonlyArray<{ worktreePath: string; files: readonly GitFileChange[] }>,
): GitChangeEntry[] {
  return groups.flatMap((group) => fileTreeItemsInOrder(group.files)
    .map((file) => ({ worktreePath: group.worktreePath, file })));
}

/** Advance in the source region after the batch, using its pre-operation tree order. */
export function nextChangeAfterIndex(
  before: readonly GitChangeEntry[],
  after: readonly GitChangeEntry[],
  operations: ReadonlyArray<GitIndexTarget & { worktreePath: string; action: GitIndexAction }>,
): GitChangeEntry | undefined {
  const requests = operations.map((operation) => ({
    operation,
    paths: operation.scope === GitIndexScope.paths ? new Set(operation.paths) : undefined,
  }));
  let last = -1;
  before.forEach((entry, index) => {
    const affected = requests.some(({ operation, paths }) => {
      if (entry.worktreePath !== operation.worktreePath
        || (operation.action === GitIndexAction.stage && entry.file.stageBlockedReason)) {
        return false;
      }
      switch (operation.scope) {
      case GitIndexScope.worktree:
        return true;
      case GitIndexScope.paths:
        return paths!.has(entry.file.path);
      case GitIndexScope.file:
        return entry.file.path === operation.path;
      case GitIndexScope.directory:
        return entry.file.path.startsWith(`${operation.path}/`);
      }
    });
    if (affected) {
      last = index;
    }
  });

  const remaining = new Map(after.map((entry) => [
    JSON.stringify([entry.worktreePath, entry.file.path]),
    entry,
  ]));
  for (let offset = 1; offset <= before.length; offset++) {
    const entry = before[(last + offset) % before.length];
    const next = remaining.get(JSON.stringify([entry.worktreePath, entry.file.path]));
    if (next) {
      return next;
    }
  }
  // If every original row disappeared, new changes still need a selection.
  return after[0];
}
