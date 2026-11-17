import type { GitIndexTarget } from '../git/git-index-target';

export type WorkspaceIndexTarget = GitIndexTarget & { projectId: string };

export interface PendingWorkspaceIndex {
  projectId: string;
  /** Undefined means the whole project is pending. */
  paths?: readonly string[];
}
