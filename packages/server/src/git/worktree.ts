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

const execFileAsync = promisify(execFile);

async function runGit(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout;
}

export async function readWorktreeStatus(repoPath: string): Promise<WorktreeStatus> {
  const output = await runGit(repoPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
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
  return status;
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
  await runGit(repoPath, [
    'commit',
    ...(input.amend ? ['--amend'] : []),
    '-m',
    input.message,
  ]);
}
