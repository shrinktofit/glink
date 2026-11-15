import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitDiffType, type ChangesSnapshot, type GitFileChange } from '@glink/protocol/git';
import { gitIndexPath } from './index-queue.ts';
import { runGit } from './run-git.ts';

export interface StatusEntry {
  staged?: GitFileChange;
  unstaged?: GitFileChange;
  headMode: string;
  indexMode: string;
  worktreeMode: string;
  embedded: boolean;
}

export async function readStatusEntries(
  repoPath: string, paths?: readonly string[], signal?: AbortSignal,
) {
  const output = await runGit(repoPath, [
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--no-ahead-behind',
    '--untracked-files=all',
    '--ignore-submodules=none',
    ...(paths ? ['--', ...paths] : []),
  ], { signal });
  const records = output.split('\0');
  const entries: StatusEntry[] = [];
  let head: string | undefined;
  let branch: string | undefined;
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice(13);
      head = value === '(initial)' ? undefined : value;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice(14);
      branch = value === '(detached)' ? undefined : value;
      continue;
    }
    if (record.startsWith('# ') || record.startsWith('! ')) {
      continue;
    }
    if (record.startsWith('? ')) {
      const path = record.slice(2);
      const entry: StatusEntry = {
        unstaged: { path, type: GitDiffType.untracked },
        headMode: '000000',
        indexMode: '000000',
        worktreeMode: '000000',
        embedded: false,
      };
      if (path.endsWith('/')) {
        try {
          await lstat(join(repoPath, path, '.git'));
          entry.embedded = true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        if (entry.embedded) {
          const child = await runGit(join(repoPath, path), [
            'status',
            '--porcelain=v2',
            '-z',
            '--untracked-files=all',
            '--ignore-submodules=none',
          ], { signal });
          if (child) {
            entry.unstaged!.stageBlockedReason = dirtySubmoduleReason(path);
          }
        }
      }
      entries.push(entry);
      continue;
    }
    // Split metadata only: paths can contain spaces, tabs and newlines.
    const fields = record.split(' ');
    const kind = fields[0];
    const xy = fields[1];
    const sub = fields[2];
    if (kind === 'u') {
      const path = fields.slice(10).join(' ');
      entries.push({
        unstaged: {
          path,
          type: GitDiffType.unmerged,
          ...(sub.startsWith('S') && (sub[2] === 'M' || sub[3] === 'U')
            ? { stageBlockedReason: dirtySubmoduleReason(path) }
            : {}),
        },
        headMode: fields[3],
        indexMode: fields[4],
        worktreeMode: fields[6],
        embedded: false,
      });
      continue;
    }
    if (kind !== '1' && kind !== '2') {
      throw new Error(`Unknown Git status record: ${kind}`);
    }
    const path = fields.slice(kind === '2' ? 9 : 8).join(' ');
    const originalPath = kind === '2' ? records[++index] : undefined;
    const dirty = sub.startsWith('S') && (sub[2] === 'M' || sub[3] === 'U');
    const entry: StatusEntry = {
      headMode: fields[3],
      indexMode: fields[4],
      worktreeMode: fields[5],
      embedded: false,
    };
    if (!xy.startsWith('.')) {
      entry.staged = { path, type: xy[0] as GitDiffType };
      if (originalPath) {
        entry.staged.originalPath = originalPath;
      }
    }
    if (xy[1] !== '.') {
      entry.unstaged = { path, type: xy[1] as GitDiffType };
      if (/[RC]/.test(xy[1]) && originalPath) {
        entry.unstaged.originalPath = originalPath;
      }
      if (dirty) {
        entry.unstaged.stageBlockedReason = dirtySubmoduleReason(path);
      }
    }
    // The working tree can be dirty even when the staged pointer is an unrelated HEAD change.
    if (dirty && entry.staged && (entry.headMode === '160000' || entry.indexMode === '160000')) {
      entry.staged.stageBlockedReason = dirtySubmoduleReason(path);
    }
    entries.push(entry);
  }
  return { head, branch, entries };
}

function dirtySubmoduleReason(path: string) {
  return `子模块 ${path} 有未提交的修改，不能暂存、提交或修订其指针。`;
}

export async function readSubmodulePaths(repoPath: string, signal?: AbortSignal) {
  const output = await runGit(repoPath, ['ls-files', '--stage', '-z'], { signal });
  return output.split('\0').flatMap((entry) => {
    const match = /^160000 [a-f0-9]+ 0\t(.*)$/s.exec(entry);
    return match ? [match[1]] : [];
  });
}

export async function readChangesSnapshot(
  repoPath: string,
  options: { indexPath?: string; submodules?: boolean; signal?: AbortSignal } = {},
): Promise<ChangesSnapshot> {
  const [status, path] = await Promise.all([
    readStatusEntries(repoPath, undefined, options.signal),
    options.indexPath ?? gitIndexPath(repoPath, options.signal),
  ]);
  let indexFingerprint: string;
  try {
    indexFingerprint = createHash('sha256')
      .update(await readFile(path, { signal: options.signal })).digest('hex');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    indexFingerprint = 'missing';
  }
  const staged = status.entries.flatMap((entry) => entry.staged ? [entry.staged] : []);
  const commitBlockedReason = staged.find((file) => file.stageBlockedReason)?.stageBlockedReason;
  // Blocking applies to pointer changes in this index, not pointers already recorded in HEAD.
  for (const file of staged) {
    delete file.stageBlockedReason;
  }
  return {
    head: status.head,
    branch: status.branch,
    staged,
    unstaged: status.entries.flatMap((entry) => entry.unstaged ? [entry.unstaged] : []),
    commitBlockedReason,
    amendBlockedReason: commitBlockedReason,
    indexFingerprint,
    ...(options.submodules
      ? { submodulePaths: await readSubmodulePaths(repoPath, options.signal) }
      : {}),
  };
}
