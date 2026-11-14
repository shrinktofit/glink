export const commitGraphPath = '/api/git/commits';
export const commitGraphLimit = 500;
export const worktreeStatusPath = '/api/git/status';
export const fileDiffPath = '/api/git/diff';
export const gitIndexPath = '/api/git/index';
export const gitCommitPath = '/api/git/commit';
export const commitDetailPath = '/api/git/commit-detail';
export const commitDiffPath = '/api/git/commit-diff';
export const repositoryOverviewPath = '/api/git/overview';

export interface GitReference {
  name: string;
  sha: string;
  current: boolean;
}

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  current: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  branches: GitReference[];
}

export interface GitStash {
  name: string;
  sha: string;
  subject: string;
}

export interface GitSubmodule {
  path: string;
  sha: string;
  initialized: boolean;
}

export interface RepositoryOverview {
  rootPath: string;
  worktrees: GitWorktree[];
  branches: GitReference[];
  remotes: GitRemote[];
  tags: GitReference[];
  stashes: GitStash[];
  submodules: GitSubmodule[];
}

export enum GitDiffType {
  added = 'A',
  deleted = 'D',
  modified = 'M',
  renamed = 'R',
  copied = 'C',
  unmerged = 'U',
  typeChanged = 'T',
  untracked = '?',
}

export enum GitIndexAction {
  stage = 'stage',
  unstage = 'unstage',
}

export interface GitFileChange {
  path: string;
  originalPath?: string;
  type: GitDiffType;
}

export interface WorktreeStatus {
  unstaged: GitFileChange[];
  staged: GitFileChange[];
  headMessage?: string;
}

export interface FileDiffResponse {
  original: string;
  modified: string;
}

export interface GitCommitInput {
  message: string;
  amend: boolean;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string;
}

export interface CommitGraphResponse {
  commits: GitCommit[];
}

export interface GitCommitDetail extends GitCommit {
  message: string;
  authorEmail: string;
  files: GitFileChange[];
}
