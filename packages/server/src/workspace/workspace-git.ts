import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { GitCommit } from '@glink/protocol/git';
import type {
  WorkspaceBranch,
  WorkspaceProject,
  WorkspaceProjectStatus,
} from '@glink/protocol/workspace';
import { readWorktreeStatus } from '../git/worktree.ts';

const execFileAsync = promisify(execFile);

export async function runWorkspaceGit(path: string, args: string[]) {
  const { stdout } = await execFileAsync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout;
}

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
    runWorkspaceGit(canonical, ['rev-parse', '--show-toplevel']),
    runWorkspaceGit(canonical, [
      'log',
      '--ignore-missing',
      'HEAD',
      '-1',
      '--format=%H',
    ]),
    runWorkspaceGit(canonical, ['branch', '--show-current']),
    runWorkspaceGit(canonical, ['ls-files', '--stage', '-z']),
  ]);
  if (root.trim().toLowerCase() !== canonical.toLowerCase()) {
    throw new Error('Select a worktree root.');
  }
  const submodules: Array<{ path: string; sha: string }> = [];
  for (const entry of index.split('\0')) {
    const match = /^160000 ([a-f0-9]+) 0\t(.*)$/s.exec(entry);
    if (match) {
      submodules.push({ path: match[2], sha: match[1] });
    }
  }
  return {
    path: canonical,
    head: head.trim() || undefined,
    branch: branch.trim() || undefined,
    submodules,
  };
}

export async function readProjectStatus(
  project: WorkspaceProject,
): Promise<WorkspaceProjectStatus> {
  if (!(await hasWorktree(project.worktreePath))) {
    throw new Error('Worktree is unavailable or not initialized.');
  }
  const [
    status,
    head,
    branch,
    indexPath,
  ] = await Promise.all([
    readWorktreeStatus(project.worktreePath),
    runWorkspaceGit(project.worktreePath, [
      'log',
      '--ignore-missing',
      'HEAD',
      '-1',
      '--format=%H',
    ]),
    runWorkspaceGit(project.worktreePath, ['branch', '--show-current']),
    runWorkspaceGit(project.worktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ]),
  ]);
  let indexFingerprint: string;
  try {
    indexFingerprint = createHash('sha256')
      .update(await readFile(indexPath.trim()))
      .digest('hex');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    indexFingerprint = 'missing';
  }
  const headSha = head.trim() || undefined;
  let amendBlockedReason = status.amendBlockedReason;
  if (!headSha || !project.baseCommit) {
    amendBlockedReason = '需要有效的 HEAD 和基础提交才能修订。';
  } else if (headSha === project.baseCommit) {
    amendBlockedReason = 'HEAD 必须位于基础提交之后才能修订。';
  } else {
    try {
      await runWorkspaceGit(project.worktreePath, [
        'merge-base',
        '--is-ancestor',
        project.baseCommit,
        headSha,
      ]);
    } catch (error: unknown) {
      if ((error as { code?: number }).code !== 1) {
        throw error;
      }
      amendBlockedReason = 'HEAD 必须位于基础提交之后才能修订。';
    }
  }
  return {
    ...status,
    projectId: project.id,
    head: headSha,
    baseCommit: project.baseCommit,
    amendBlockedReason,
    branch: branch.trim() || undefined,
    indexFingerprint,
  };
}

export async function readProjectCommits(project: WorkspaceProject): Promise<GitCommit[]> {
  const output = await runWorkspaceGit(project.worktreePath, [
    'log',
    '--ignore-missing',
    '--topo-order',
    '--max-count=500',
    '--no-show-signature',
    '--format=%H%x00%P%x00%s%x00%an%x00%aI',
    '-z',
    project.baseCommit ? `${project.baseCommit}..HEAD` : 'HEAD',
  ]);
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
  const output = await runWorkspaceGit(project.worktreePath, [
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
