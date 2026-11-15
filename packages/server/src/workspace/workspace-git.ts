import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitCommit } from '@glink/protocol/git';
import type {
  WorkspaceBranch,
  WorkspaceProject,
  WorkspaceProjectStatus,
} from '@glink/protocol/workspace';
import { readWorktreeStatus } from '../git/worktree.ts';
import { runGit } from '../git/run-git.ts';
import { readSubmodulePaths } from '../git/read-changes.ts';

export async function hasWorktree(path: string) {
  try {
    await lstat(join(path, '.git'));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function parseIndexSubmodules(index: string) {
  const submodules: Array<{ path: string; sha: string }> = [];
  for (const entry of index.split('\0')) {
    const match = /^160000 ([a-f0-9]+) 0\t(.*)$/s.exec(entry);
    if (match) {
      submodules.push({ path: match[2], sha: match[1] });
    }
  }
  return submodules;
}

export async function inspectWorktree(path: string) {
  if (!(await hasWorktree(path))) {
    throw new Error(`Not an initialized worktree: ${path}`);
  }
  const canonical = (await realpath(path)).replaceAll('\\', '/');
  const [
    root,
    head,
    branch,
    index,
  ] = await Promise.all([
    runGit(canonical, ['rev-parse', '--show-toplevel']),
    runGit(canonical, [
      'log',
      '--ignore-missing',
      'HEAD',
      '-1',
      '--format=%H',
    ]),
    runGit(canonical, ['branch', '--show-current']),
    runGit(canonical, ['ls-files', '--stage', '-z']),
  ]);
  if (root.trim().toLowerCase() !== canonical.toLowerCase()) {
    throw new Error('Select a worktree root.');
  }
  return {
    path: canonical,
    head: head.trim() || undefined,
    branch: branch.trim() || undefined,
    submodules: parseIndexSubmodules(index),
  };
}

export async function readProjectStatus(
  project: WorkspaceProject, signal?: AbortSignal,
): Promise<WorkspaceProjectStatus> {
  if (!(await hasWorktree(project.worktreePath))) {
    throw new Error('Worktree is unavailable or not initialized.');
  }
  const [status, submodulePaths] = await Promise.all([
    readWorktreeStatus(project.worktreePath, signal),
    readSubmodulePaths(project.worktreePath, signal),
  ]);
  let baseAmendBlockedReason: string | undefined;
  let aheadCount: number | undefined;
  if (!status.head || !project.baseCommit) {
    baseAmendBlockedReason = '需要有效的 HEAD 和基础提交才能修订。';
  } else if (status.head === project.baseCommit) {
    aheadCount = 0;
    baseAmendBlockedReason = 'HEAD 必须位于基础提交之后才能修订。';
  } else {
    const counts = await runGit(project.worktreePath, [
      'rev-list',
      '--left-right',
      '--count',
      `${project.baseCommit}...${status.head}`,
    ], { signal });
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
    aheadCount = ahead;
    if (behind > 0 || ahead === 0) {
      baseAmendBlockedReason = 'HEAD 必须位于基础提交之后才能修订。';
    }
  }
  return {
    ...status,
    projectId: project.id,
    baseCommit: project.baseCommit,
    aheadCount,
    baseAmendBlockedReason,
    amendBlockedReason: baseAmendBlockedReason ?? status.amendBlockedReason,
    submodulePaths,
  };
}

export async function readProjectCommits(
  project: WorkspaceProject, signal?: AbortSignal,
): Promise<GitCommit[]> {
  const output = await runGit(project.worktreePath, [
    'log',
    '--ignore-missing',
    '--topo-order',
    '--max-count=500',
    '--no-show-signature',
    '--format=%H%x00%P%x00%s%x00%an%x00%aI',
    '-z',
    project.baseCommit ? `${project.baseCommit}..HEAD` : 'HEAD',
  ], { signal });
  const fields = output.split('\0');
  const commits: GitCommit[] = [];
  for (let index = 0; index < fields.length - 1; index += 5) {
    commits.push({
      sha: fields[index],
      parents: fields[index + 1] ? fields[index + 1].split(' ') : [],
      subject: fields[index + 2],
      author: fields[index + 3],
      authoredAt: fields[index + 4],
    });
  }
  return commits;
}

export async function readProjectBranches(project: WorkspaceProject): Promise<WorkspaceBranch[]> {
  if (!await hasWorktree(project.worktreePath)) {
    throw new Error('Worktree is unavailable or not initialized.');
  }
  const output = await runGit(project.worktreePath, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)',
    'refs/heads',
    'refs/remotes',
  ]);
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const [
      ref,
      sha,
      current,
      symbolic,
    ] = line.split('\0');
    if (symbolic) {
      return [];
    }
    return [{
      name: ref.slice(ref.startsWith('refs/heads/') ? 11 : 13),
      revision: ref.startsWith('refs/heads/') ? ref.slice(11) : ref,
      sha,
      current: current === '*',
    }];
  });
}
