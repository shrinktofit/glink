export const worktreeDeletionPath = '/api/worktree-deletion';

export interface WorktreeDeletionTarget {
  path: string;
  main: boolean;
  branch?: string;
  head?: string;
  /** References containing HEAD that will remain after this deletion. */
  survivingRefs: string[];
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

export enum WorktreeDeletionPhase {
  queued = 'queued',
  revalidate = 'revalidate',
  scan = 'scan',
  unlink = 'unlink',
  clean = 'clean',
  remove = 'remove',
  verify = 'verify',
  deleted = 'deleted',
  records = 'records',
  failed = 'failed',
}

export const worktreeDeletionPhaseDescriptions: Record<WorktreeDeletionPhase, string> = {
  queued: '等待执行',
  revalidate: '重新验证删除范围和工作区状态',
  scan: '收集符号链接和Junctions',
  unlink: '解除符号链接和 junction',
  clean: '清理未跟踪及被忽略的文件',
  remove: '移除工作树',
  verify: '验证删除结果',
  deleted: '已删除',
  records: '清理工作区项目及依赖记录',
  failed: '删除失败',
};

export interface WorktreeDeletionProgress {
  phase: WorktreeDeletionPhase;
  worktreePath?: string;
  completed: number;
  total: number;
  detail?: string;
}

export type WorktreeDeletionEvent = { progress: WorktreeDeletionProgress }
  | { result: WorktreeDeletionResult } | { error: string };

export enum WorktreePreflightCheck {
  topology = 'topology',
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
