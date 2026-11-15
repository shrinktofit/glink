export enum GitIndexScope {
  file = 'file',
  directory = 'directory',
  worktree = 'worktree',
}

export type GitIndexTarget
  = | { scope: GitIndexScope.file; path: string }
    | { scope: GitIndexScope.directory; path: string }
    | { scope: GitIndexScope.worktree };
