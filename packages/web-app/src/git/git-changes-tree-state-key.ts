/** The same worktree and area share folder state in repository and workspace views. */
export function gitChangesTreeStateKey(worktreePath: string, staged: boolean) {
  return JSON.stringify([
    'git-changes',
    worktreePath.replaceAll('\\', '/').replace(/\/+$/, ''),
    staged ? 'staged' : 'unstaged',
  ]);
}
