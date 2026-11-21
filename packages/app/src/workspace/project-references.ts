import { GitRevisionKind, type GitReferenceOption } from '@glink/protocol/git';
import {
  BaselineRefState,
  type BaselineRefComparison,
  type ProjectBaseline,
  type WorkspaceProject,
} from '@glink/protocol/workspace';
import { runGit } from '../git/run-git.ts';
import { WorkspaceError } from './workspace-error.ts';

export async function readCommitSha(path: string, revision: string, signal?: AbortSignal) {
  try {
    return (await runGit(path, [
      'rev-parse',
      '--quiet',
      '--verify',
      '--end-of-options',
      `${revision}^{commit}`,
    ], { signal })).trim();
  } catch (error: unknown) {
    signal?.throwIfAborted();
    if ((error as { code?: number }).code === 1) {
      throw new WorkspaceError('提交不存在、不是 commit 或短 hash 不唯一。');
    }
    throw error;
  }
}

export async function checkReferenceName(path: string, ref: string, signal?: AbortSignal) {
  if (!/^refs\/(heads|remotes|tags)\/.+/.test(ref)) {
    throw new WorkspaceError('请选择完整的分支或标签引用名。');
  }
  try {
    await runGit(path, ['check-ref-format', ref], { signal });
  } catch (error: unknown) {
    signal?.throwIfAborted();
    if ((error as { code?: number }).code === 1) {
      throw new WorkspaceError('Git 引用名无效。');
    }
    throw error;
  }
}

/** Absence is distinct from an unreadable repository or a reference to a non-commit object. */
export async function readReferenceCommit(path: string, ref: string, signal?: AbortSignal) {
  await checkReferenceName(path, ref, signal);
  const names = await runGit(path, ['for-each-ref', '--format=%(refname)', ref], { signal });
  if (!names.split('\n').includes(ref)) {
    return undefined;
  }
  return readCommitSha(path, ref, signal);
}

export async function readProjectReferences(
  project: WorkspaceProject,
  signal?: AbortSignal,
): Promise<GitReferenceOption[]> {
  const output = await runGit(project.worktreePath, [
    'for-each-ref',
    '--format=%(refname)%00%(HEAD)%00%(symref)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ], { signal });
  const entries = output.split('\n').filter(Boolean).flatMap((line) => {
    const [ref, current, symbolic] = line.split('\0');
    return symbolic ? [] : [{ ref, current: current === '*' }];
  });
  if (!entries.length) {
    return [];
  }

  // A single batch peels lightweight, annotated and nested tags without one process per ref.
  const objects = await runGit(project.worktreePath, [
    'cat-file',
    '--batch-check=%(objectname) %(objecttype)',
  ], {
    input: entries.map((entry) => `${entry.ref}^{commit}\n`).join(''),
    signal,
  });
  const commits = objects.trimEnd().split('\n');

  return entries.flatMap((entry, index) => {
    const [commit, type] = commits[index].split(' ');
    if (type === 'missing') {
      return [];
    }
    if (type !== 'commit') {
      throw new Error(`Expected a commit for ${entry.ref}: ${commits[index]}`);
    }
    const kind = entry.ref.startsWith('refs/tags/') ? GitRevisionKind.tag : GitRevisionKind.branch;
    const prefix = entry.ref.startsWith('refs/remotes/')
      ? 'refs/remotes/'
      : kind === GitRevisionKind.tag ? 'refs/tags/' : 'refs/heads/';

    return [{
      ...entry,
      kind,
      name: entry.ref.slice(prefix.length),
      commit,
    }];
  });
}

export async function readBaselineComparison(
  project: WorkspaceProject,
  baseline: ProjectBaseline & { ref: string },
  signal?: AbortSignal,
): Promise<BaselineRefComparison> {
  if (!/^[a-f0-9]{4,64}$/i.test(baseline.commit)) {
    throw new WorkspaceError('基线需要有效的 commit hash。');
  }
  const commit = await readReferenceCommit(project.worktreePath, baseline.ref, signal);
  if (!commit) {
    return { state: BaselineRefState.missing };
  }
  const counts = await runGit(project.worktreePath, [
    'rev-list',
    '--left-right',
    '--count',
    `${baseline.commit}...${commit}`,
  ], { signal });
  const [aheadCount, behindCount] = counts.trim().split(/\s+/).map(Number);

  return {
    state: BaselineRefState.available,
    commit,
    aheadCount,
    behindCount,
  };
}
