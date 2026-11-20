import { lstat, readFile, readlink } from 'node:fs/promises';
import {
  GitDiffType,
  GitIndexAction,
  type ChangesSnapshot,
  type FileDiffResponse,
  type GitCommitInput,
  type GitFileChange,
  type WorktreeStatus,
} from '@glink/protocol/git';
import { join } from 'node:path';
import { GitSubmoduleDirtyError } from './git-submodule-dirty-error.ts';
import { readChangesSnapshot, readStatusEntries, type StatusEntry } from './read-changes.ts';
import { runGit } from './run-git.ts';
import { withGitIndex } from './index-queue.ts';
import { indexStageBlocker } from './index-stage-blocker.ts';

export async function readWorktreeStatus(
  repoPath: string, signal?: AbortSignal,
): Promise<WorktreeStatus> {
  const changes = await readChangesSnapshot(repoPath, { signal });
  const message = changes.head
    ? await runGit(repoPath, [
      'log',
      '-1',
      '--format=%B',
      changes.head,
    ], { signal })
    : undefined;
  return { ...changes, headMessage: message?.trimEnd() };
}

async function readStoredFile(
  repoPath: string, path: string, index: boolean, signal?: AbortSignal,
) {
  const entry = index
    ? await runGit(repoPath, [
      'ls-files',
      '--stage',
      '-z',
      '--',
      path,
    ], { signal })
    : await runGit(repoPath, [
      'ls-tree',
      '-z',
      'HEAD',
      '--',
      path,
    ], { signal });
  const metadata = entry.slice(0, entry.indexOf('\t')).split(' ');
  const mode = metadata[0];
  const sha = metadata[index ? 1 : 2];
  if (!sha) {
    throw new Error('File is no longer present in the selected revision.');
  }
  if (mode === '160000') {
    return `Subproject commit ${sha}\n`;
  }
  return runGit(repoPath, ['cat-file', 'blob', sha], { signal });
}

export async function readFileDiff(
  repoPath: string, path: string, staged: boolean, signal?: AbortSignal,
): Promise<FileDiffResponse> {
  const status = await readStatusEntries(repoPath, [path], signal);
  let change = status.entries.map((entry) => staged ? entry.staged : entry.unstaged)
    .find((item) => item?.path === path);
  if (staged && change?.type === GitDiffType.added) {
    const indexed = await readIndexChanges(repoPath, signal);
    change = indexed.entries.find((entry) => entry.staged?.path === path)?.staged ?? change;
  }
  if (!change) {
    throw new Error('File is no longer in this change list. Refresh and try again.');
  }
  if (change.type === GitDiffType.unmerged) {
    throw new Error('Resolve merge conflicts before comparing this file.');
  }
  let original = '';
  let modified = '';
  if (change.type !== GitDiffType.added && change.type !== GitDiffType.untracked) {
    original = await readStoredFile(repoPath, change.originalPath ?? path, !staged, signal);
  }
  if (change.type !== GitDiffType.deleted) {
    if (staged) {
      modified = await readStoredFile(repoPath, path, true, signal);
    } else {
      const absolutePath = join(repoPath, path);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        modified = await readlink(absolutePath);
      } else if (info.isDirectory()) {
        const sha = (await runGit(absolutePath, ['rev-parse', 'HEAD'], { signal })).trim();
        const dirty = await runGit(absolutePath, ['status', '--porcelain'], { signal });
        modified = `Subproject commit ${sha}${dirty ? '-dirty' : ''}\n`;
      } else {
        modified = await readFile(absolutePath, { encoding: 'utf8', signal });
      }
    }
  }
  if (original.includes('\0') || modified.includes('\0')) {
    throw new Error('Binary files cannot be displayed as text.');
  }
  return { original, modified };
}

/** Read only index-vs-HEAD metadata, preserving cross-directory rename pairs. */
async function readIndexChanges(repoPath: string, signal?: AbortSignal) {
  const [output, head] = await Promise.all([
    runGit(repoPath, [
      'diff',
      '--cached',
      '--raw',
      '-z',
      '--find-renames',
      '--no-abbrev',
      '--no-ext-diff',
      '--ignore-submodules=none',
      '--',
    ], { signal }),
    runGit(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      'HEAD',
    ], { signal }).then(
      (head) => head.trim(),
      (error: unknown) => {
        if ((error as { code?: number }).code === 1) {
          return undefined;
        }
        throw error;
      },
    ),
  ]);
  const records = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length - 1;) {
    const metadata = records[index++].slice(1).split(' ');
    const type = metadata[4][0] as GitDiffType;
    const first = records[index++];
    const renamed = type === GitDiffType.renamed || type === GitDiffType.copied;
    const path = renamed ? records[index++] : first;
    entries.push({
      staged: { path, type, ...(renamed ? { originalPath: first } : {}) },
      headMode: metadata[0],
      indexMode: metadata[1],
      worktreeMode: metadata[1],
      embedded: false,
    });
  }
  return { entries, head };
}

export class GitIndexTransaction {
  static run<T>(repoPath: string, action: (index: GitIndexTransaction) => Promise<T>) {
    return withGitIndex(repoPath, (path) => action(new GitIndexTransaction(repoPath, path)));
  }

  readonly repoPath: string;
  readonly indexPath: string;

  readChanges(submodules = false) {
    return readChangesSnapshot(this.repoPath, { indexPath: this.indexPath, submodules });
  }

  async change(
    path: string,
    action: GitIndexAction,
    stageBlockers?: ReadonlyMap<string, Error>,
  ): Promise<ChangesSnapshot> {
    const state = action === GitIndexAction.stage
      ? await readStatusEntries(this.repoPath, [path])
      : await readIndexChanges(this.repoPath);
    const entry = state.entries.find((entry) => {
      const file = action === GitIndexAction.stage ? entry.unstaged : entry.staged;
      return file?.path === path || file?.path === `${path}/`;
    });
    const file = action === GitIndexAction.stage ? entry?.unstaged : entry?.staged;
    if (!file || !entry) {
      throw new Error('File is no longer in this change list. Refresh and try again.');
    }
    if (action === GitIndexAction.stage && file.stageBlockedReason) {
      throw new GitSubmoduleDirtyError(file.stageBlockedReason);
    }
    const blocker = action === GitIndexAction.stage && indexStageBlocker(file, stageBlockers);
    if (blocker) {
      throw blocker;
    }
    await this._write([file], action, state.head);
    return this.readChanges(this._changesSubmoduleMembership(entry, file, action));
  }

  async changeAll(
    action: GitIndexAction,
    directory?: string,
    stageBlockers?: ReadonlyMap<string, Error>,
  ): Promise<ChangesSnapshot> {
    return this._changeBatch(action,
      (file) => directory === undefined || file.path.startsWith(`${directory}/`),
      directory === undefined ? undefined : [directory],
      stageBlockers);
  }

  changePaths(
    paths: readonly string[],
    action: GitIndexAction,
    stageBlockers?: ReadonlyMap<string, Error>,
  ): Promise<ChangesSnapshot> {
    if (paths.length === 1) {
      return this.change(paths[0], action, stageBlockers);
    }
    const selected = new Set(paths);
    return this._changeBatch(action, (file) => selected.has(file.path), undefined, stageBlockers);
  }

  async commit(input: GitCommitInput) {
    const state = await this.readChanges();
    const blocked = input.amend ? state.amendBlockedReason : state.commitBlockedReason;
    if (blocked) {
      throw new GitSubmoduleDirtyError(blocked);
    }
    await runGit(this.repoPath, [
      'commit',
      ...(input.amend ? ['--amend'] : []),
      '-m',
      input.message,
    ]);
  }

  private constructor(repoPath: string, indexPath: string) {
    this.repoPath = repoPath;
    this.indexPath = indexPath;
  }

  private async _changeBatch(
    action: GitIndexAction,
    includes: (file: GitFileChange) => boolean,
    statusPaths?: readonly string[],
    stageBlockers?: ReadonlyMap<string, Error>,
  ) {
    const state = action === GitIndexAction.stage
      ? await readStatusEntries(this.repoPath, statusPaths)
      : await readIndexChanges(this.repoPath);
    const selected = state.entries.flatMap((entry) => {
      const file = action === GitIndexAction.stage ? entry.unstaged : entry.staged;
      if (!file || !includes(file)
        || (action === GitIndexAction.stage
          && (file.stageBlockedReason || indexStageBlocker(file, stageBlockers)))) {
        return [];
      }
      return [{ entry, file }];
    });
    await this._write(selected.map(({ file }) => file), action, state.head);
    return this.readChanges(selected.some(({ entry, file }) =>
      this._changesSubmoduleMembership(entry, file, action),
    ));
  }

  private _changesSubmoduleMembership(
    entry: StatusEntry, file: GitFileChange, action: GitIndexAction,
  ) {
    const from = action === GitIndexAction.stage ? entry.indexMode : entry.headMode;
    const to = action === GitIndexAction.stage ? entry.worktreeMode : entry.indexMode;
    return entry.embedded || ((from === '160000') !== (to === '160000'))
      || (file.type === GitDiffType.renamed && (from === '160000' || to === '160000'));
  }

  private async _write(changes: readonly GitFileChange[], action: GitIndexAction, head?: string) {
    if (!changes.length) {
      return;
    }
    const paths = [...new Set(changes.flatMap((file) =>
      file.type === GitDiffType.renamed && file.originalPath
        ? [file.path, file.originalPath]
        : [file.path],
    ))];
    const command = action === GitIndexAction.stage
      ? ['add']
      : head ? ['reset', '-q', 'HEAD'] : ['rm', '--cached', '-f'];
    await runGit(this.repoPath, [...command, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: paths.join('\0') + '\0',
    });
  }
}

export function changeIndex(repoPath: string, path: string, action: GitIndexAction) {
  return GitIndexTransaction.run(repoPath, (index) => index.change(path, action));
}

export function changeAllIndex(repoPath: string, action: GitIndexAction, directory?: string) {
  return GitIndexTransaction.run(repoPath, (index) => index.changeAll(action, directory));
}

export function changeIndexPaths(
  repoPath: string,
  paths: readonly string[],
  action: GitIndexAction,
) {
  return GitIndexTransaction.run(repoPath, (index) => index.changePaths(paths, action));
}

export function commitWorktree(repoPath: string, input: GitCommitInput) {
  return GitIndexTransaction.run(repoPath, (index) => index.commit(input));
}
