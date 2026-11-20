import type { ChangesSnapshot, GitCommit, GitRevision, WorktreeStatus } from './git';

export const glinkStatePath = '/api/glink/state';
export const workspacesPath = '/api/workspaces';

export enum WorkspaceConnectionKind {
  manual = 'manual',
  submodule = 'submodule',
}

export interface ProjectBaseline {
  /** Full commit object ID; ref changes never move this snapshot automatically. */
  commit: string;
  ref?: string;
}

export enum BaselineRefState {
  available = 'available',
  missing = 'missing',
}

/** Counts are relative to the pinned baseline, never relative to HEAD. */
export type BaselineRefComparison = {
  state: BaselineRefState.available;
  commit: string;
  aheadCount: number;
  behindCount: number;
} | {
  state: BaselineRefState.missing;
};

export interface WorkspaceProject {
  id: string;
  name: string;
  worktreePath: string;
  baseline?: ProjectBaseline;
  enabled: boolean;
  settled: boolean;
  binding: GitRevision;
}

export interface WorkspaceConnection {
  from: string;
  to: string;
  kind: WorkspaceConnectionKind;
}

export interface WorkspaceDocument {
  version: 3;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  projects: WorkspaceProject[];
  connections: WorkspaceConnection[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  fileName: string;
  projectCount: number;
  updatedAt: string;
}

export interface GlinkState {
  version: 1;
  workspaces: WorkspaceSummary[];
}

export interface GlinkCatalog extends GlinkState {
  home: string;
}

export interface CreateWorkspaceInput {
  name: string;
  worktreePaths: string[];
  dependencies?: Array<{ fromPath: string; toPath: string }>;
}

export interface UpdateProjectInput {
  name: string;
  settled: boolean;
  baseline?: ProjectBaseline;
  binding: WorkspaceProject['binding'];
  dependencyIds: string[];
}

/** Workspace-only metadata edits; association changes do not checkout the worktree. */
export interface PatchProjectInput {
  name?: string;
  enabled?: boolean;
  confirmDisable?: boolean;
  settled?: boolean;
  baseline?: ProjectBaseline | null;
  binding?: WorkspaceProject['binding'];
  manualDependencyIds?: string[];
}

export interface ProjectDisableConfirmation {
  projectId: string;
  reasons: string[];
}

export interface WorkspaceProjectStatus extends WorktreeStatus {
  projectId: string;
  baselineCommit?: string;
  /** Commits reachable from HEAD but not from the pinned baseline. */
  aheadCount?: number;
  error?: string;
  /** Base/HEAD ancestry restriction, independent of dirty staged gitlinks. */
  baseAmendBlockedReason?: string;
  bindingMismatch?: boolean;
}

export interface WorkspaceChangesSnapshot extends ChangesSnapshot {
  projectId: string;
  baselineCommit?: string;
}

export interface WorkspaceCommit extends GitCommit {
  projectId: string;
}

export interface WorkspaceCommitInput {
  projectIds: string[];
  message: string;
  amend?: boolean;
  expected: Array<{
    projectId: string;
    head?: string;
    baselineCommit?: string;
    indexFingerprint: string;
  }>;
}

export interface WorkspaceCommitResult {
  committed: Array<{ projectId: string; sha: string }>;
  skipped: string[];
  failed?: { projectId: string; error: string };
}
