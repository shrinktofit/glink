export const worktreeDeletionPath = '/api/worktree-deletion';

export interface WorktreeDeletionTarget {
  path: string;
  main: boolean;
  branch?: string;
  head?: string;
  detached: boolean;
  changes: boolean;
}

export interface WorktreeDeletionReference {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  worktreePath: string;
}

export interface WorktreeDeletionPlan {
  token: string;
  worktreePath: string;
  worktrees: WorktreeDeletionTarget[];
  references: WorktreeDeletionReference[];
}

export interface WorktreeDeletionResult {
  deleted: string[];
  failed?: { path: string; error: string };
  remaining: string[];
  recordErrors: Array<{ workspaceId: string; error: string }>;
  cleanupToken?: string;
}

export enum WorktreePreflightCheck {
  topology = 'topology',
  files = 'files',
  references = 'references',
  review = 'review',
}
export enum WorktreePreflightState {
  pending = 'pending',
  inProgress = 'in-progress',
  ok = 'ok',
  warn = 'warn',
  error = 'error',
}
export const worktreePreflightChecks = [
  { id: WorktreePreflightCheck.topology, description: '检查工作树、递归子模块及 Git 数据归属' },
  { id: WorktreePreflightCheck.files, description: '检查嵌套仓库、符号链接和删除范围' },
  { id: WorktreePreflightCheck.references, description: '检查所有工作区的引用及项目依赖' },
  { id: WorktreePreflightCheck.review, description: '检查本地数据丢失风险' },
];
export interface WorktreePreflightProgress {
  id: WorktreePreflightCheck;
  state: WorktreePreflightState;
  detail?: string;
}
export type WorktreePreflightEvent = { progress: WorktreePreflightProgress }
  | { plan: WorktreeDeletionPlan } | { error: string };
