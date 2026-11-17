export enum GitIndexScope {
  file = 'file',
  paths = 'paths',
  directory = 'directory',
  worktree = 'worktree',
}

export type GitIndexTarget
  = | { scope: GitIndexScope.file; path: string }
    | { scope: GitIndexScope.paths; paths: readonly string[] }
    | { scope: GitIndexScope.directory; path: string }
    | { scope: GitIndexScope.worktree };

export interface GitIndexBatch {
  group: string;
  paths: readonly string[];
}

/** Undefined covers the whole worktree; otherwise disable these paths and overlapping folders. */
export function gitIndexPendingPaths(target: GitIndexTarget) {
  switch (target.scope) {
  case GitIndexScope.worktree:
    return undefined;
  case GitIndexScope.paths:
    return target.paths;
  default:
    return [target.path];
  }
}
