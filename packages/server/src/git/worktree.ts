import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  GitDiffType,
  GitIndexAction,
  type FileDiffResponse,
  type GitCommitInput,
  type GitFileChange,
  type WorktreeStatus,
} from '@glink/protocol/git';
import { GitIndexLockedError } from './git-index-locked-error.ts';
import { GitSubmoduleDirtyError } from './git-submodule-dirty-error.ts';

const execFileAsync = promisify(execFile);

async function runGit(repoPath: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr;
    const lock = stderr?.match(/Unable to create '(.+index\.lock)': File exists\./);
    if (lock) {
      throw new GitIndexLockedError(lock[1]);
    }
    throw error;
  }
}

export async function readWorktreeStatus(repoPath: string): Promise<WorktreeStatus> {
  const output = await runGit(repoPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  const entries = output.split('\0');
  const status: WorktreeStatus = { staged: [], unstaged: [] };
  for (let index = 0; index < entries.length - 1; index++) {
    const entry = entries[index];
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    const originalPath = /[RC]/.test(x + y) ? entries[++index] : undefined;
    if (x === '?' && y === '?') {
      status.unstaged.push({ path, type: GitDiffType.untracked });
    } else if (x === 'U' || y === 'U' || x + y === 'AA' || x + y === 'DD') {
      status.unstaged.push({ path, type: GitDiffType.unmerged });
    } else {
      if (x !== ' ') {
        status.staged.push({ path, originalPath, type: x as GitDiffType });
      }
      if (y !== ' ') {
        status.unstaged.push({
          path,
          originalPath: /[RC]/.test(y) ? originalPath : undefined,
          type: y as GitDiffType,
        });
      }
    }
  }
  const head = await runGit(repoPath, [
    'log',
    '--ignore-missing',
    'HEAD',
    '-1',
    '--format=%B',
  ]);
  // An unborn repository has no log output. A commit message always ends with a newline.
  if (head) {
    status.headMessage = head.trimEnd();
  }
  const [unstagedLinks, stagedLinks] = await Promise.all([
    status.unstaged.length ? readChangedSubmodules(repoPath, false) : [],
    status.staged.length ? readChangedSubmodules(repoPath, true) : [],
  ]);
  const dirty = new Map<string, string>();
  await Promise.all([...new Set([...unstagedLinks, ...stagedLinks])]
    .map(async (path) => {
      const child = join(repoPath, path);
      try {
        await lstat(join(child, '.git'));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return; // An uninitialized or removed submodule has no working copy to inspect.
        }
        throw error;
      }
      if (await runGit(child, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ])) {
        dirty.set(path, `子模块 ${path} 有未提交的修改，不能暂存、提交或修订其指针。`);
      }
    }));
  for (const file of status.unstaged) {
    file.stageBlockedReason = dirty.get(file.path);
  }
  status.commitBlockedReason = stagedLinks.map((path) => dirty.get(path)).find(Boolean);
  // An unchanged pointer already in HEAD does not prevent amending other files or the message.
  status.amendBlockedReason = status.commitBlockedReason;
  return status;
}

async function readChangedSubmodules(repoPath: string, staged: boolean) {
  const output = await runGit(repoPath, [
    'diff',
    ...(staged ? ['--cached'] : []),
    '--raw',
    '--no-renames',
    '-z',
    '--ignore-submodules=none',
    '--',
  ]);
  const entries = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length - 1; index += 2) {
    const [oldMode, newMode] = entries[index].slice(1).split(' ');
    if (oldMode === '160000' || newMode === '160000') {
      paths.push(entries[index + 1]);
    }
  }
  return paths;
}

async function readStoredFile(repoPath: string, path: string, index: boolean) {
  const entry = index
    ? await runGit(repoPath, [
      'ls-files',
      '--stage',
      '-z',
      '--',
      path,
    ])
    : await runGit(repoPath, [
      'ls-tree',
      '-z',
      'HEAD',
      '--',
      path,
    ]);
  const metadata = entry.slice(0, entry.indexOf('\t')).split(' ');
  const mode = metadata[0];
  const sha = metadata[index ? 1 : 2];
  if (!sha) {
    throw new Error('File is no longer present in the selected revision.');
  }
  if (mode === '160000') {
    return `Subproject commit ${sha}\n`;
  }
  return runGit(repoPath, ['cat-file', 'blob', sha]);
}

export async function readFileDiff(
  repoPath: string, path: string, staged: boolean,
): Promise<FileDiffResponse> {
  const status = await readWorktreeStatus(repoPath);
  const change = (staged ? status.staged : status.unstaged).find((item) => item.path === path);
  if (!change) {
    throw new Error('File is no longer in this change list. Refresh and try again.');
  }
  if (change.type === GitDiffType.unmerged) {
    throw new Error('Resolve merge conflicts before comparing this file.');
  }
  let original = '';
  let modified = '';
  if (change.type !== GitDiffType.added && change.type !== GitDiffType.untracked) {
    original = await readStoredFile(repoPath, change.originalPath ?? path, !staged);
  }
  if (change.type !== GitDiffType.deleted) {
    if (staged) {
      modified = await readStoredFile(repoPath, path, true);
    } else {
      const absolutePath = join(repoPath, path);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        modified = await readlink(absolutePath);
      } else if (info.isDirectory()) {
        const sha = (await runGit(absolutePath, ['rev-parse', 'HEAD'])).trim();
        const dirty = await runGit(absolutePath, ['status', '--porcelain']);
        modified = `Subproject commit ${sha}${dirty ? '-dirty' : ''}\n`;
      } else {
        modified = await readFile(absolutePath, 'utf8');
      }
    }
  }
  if (original.includes('\0') || modified.includes('\0')) {
    throw new Error('Binary files cannot be displayed as text.');
  }
  return { original, modified };
}

export async function changeIndex(repoPath: string, path: string, action: GitIndexAction) {
  const status = await readWorktreeStatus(repoPath);
  const changes = action === GitIndexAction.stage ? status.unstaged : status.staged;
  const change: GitFileChange | undefined = changes.find((item) => item.path === path);
  if (!change) {
    throw new Error('File is no longer in this change list. Refresh and try again.');
  }
  const paths = change.originalPath ? [change.path, change.originalPath] : [change.path];
  if (action === GitIndexAction.stage) {
    if (change.stageBlockedReason) {
      throw new GitSubmoduleDirtyError(change.stageBlockedReason);
    }
    await runGit(repoPath, ['add', '--', ...paths]);
  } else if (status.headMessage !== undefined) {
    await runGit(repoPath, [
      'reset',
      '-q',
      'HEAD',
      '--',
      ...paths,
    ]);
  } else {
    await runGit(repoPath, [
      'rm',
      '--cached',
      '-f',
      '--',
      ...paths,
    ]);
  }
}

export async function commitWorktree(repoPath: string, input: GitCommitInput) {
  const status = await readWorktreeStatus(repoPath);
  const blockedReason = input.amend ? status.amendBlockedReason : status.commitBlockedReason;
  if (blockedReason) {
    throw new GitSubmoduleDirtyError(blockedReason);
  }
  await runGit(repoPath, [
    'commit',
    ...(input.amend ? ['--amend'] : []),
    '-m',
    input.message,
  ]);
}
