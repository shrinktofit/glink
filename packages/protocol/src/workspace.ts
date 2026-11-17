import type { ChangesSnapshot, GitCommit, GitReference, WorktreeStatus } from './git';
export interface WorkspaceBranch extends GitReference {
  revision: string;
}

export const glinkStatePath = '/api/glink/state';
export const workspacesPath = '/api/workspaces';

export enum ProjectBindingKind {
  branch = 'branch',
  commit = 'commit',
}
export enum WorkspaceConnectionKind {
  manual = 'manual',
  submodule = 'submodule',
}

export interface WorkspaceProject {
  id: string;
  name: string;
  worktreePath: string;
  baseCommit?: string;
  settled: boolean;
  binding: { kind: ProjectBindingKind; revision: string };
}

export interface WorkspaceConnection {
  from: string;
  to: string;
  kind: WorkspaceConnectionKind;
}

export interface WorkspaceDocument {
  version: 1;
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
  baseCommit?: string;
  binding: WorkspaceProject['binding'];
  dependencyIds: string[];
}

/** Workspace-only metadata edits; association changes do not checkout the worktree. */
export interface PatchProjectInput {
  name?: string;
  settled?: boolean;
  baseCommit?: string;
  binding?: WorkspaceProject['binding'];
  manualDependencyIds?: string[];
}

export interface WorkspaceProjectStatus extends WorktreeStatus {
  projectId: string;
  baseCommit?: string;
  /** Commits reachable from HEAD but not from baseCommit. */
  aheadCount?: number;
  error?: string;
  /** Base/HEAD ancestry restriction, independent of dirty staged gitlinks. */
  baseAmendBlockedReason?: string;
}

export interface WorkspaceChangesSnapshot extends ChangesSnapshot {
  projectId: string;
  baseCommit?: string;
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
    baseCommit?: string;
    indexFingerprint: string;
  }>;
}

export interface WorkspaceCommitResult {
  committed: Array<{ projectId: string; sha: string }>;
  skipped: string[];
  failed?: { projectId: string; error: string };
}
