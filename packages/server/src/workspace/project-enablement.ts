import { isAbsolute, relative } from 'node:path';
import type { ChangesSnapshot, GitFileChange } from '@glink/protocol/git';
import type { WorkspaceDocument, WorkspaceProject } from '@glink/protocol/workspace';
import { gitIndexPath, withGitIndices } from '../git/index-queue.ts';
import { indexStageBlocker } from '../git/index-stage-blocker.ts';
import { readChangesSnapshot } from '../git/read-changes.ts';
import { runGit } from '../git/run-git.ts';
import { hasWorktree } from './workspace-git.ts';
import { WorkspaceError } from './workspace-error.ts';

function childPath(parent: WorkspaceProject, child: WorkspaceProject) {
  const path = relative(parent.worktreePath, child.worktreePath).replaceAll('\\', '/');
  return path && path !== '..' && !path.startsWith('../') && !isAbsolute(path) ? path : undefined;
}

/** HEAD keeps deleted gitlinks protected even after submodule discovery removes their edges. */
export async function readDisabledSubmodulePointers(
  parent: WorkspaceProject,
  disabled: readonly WorkspaceProject[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, WorkspaceError>> {
  const candidates = disabled.flatMap((child) => {
    const path = childPath(parent, child);
    return path ? [{ path, child }] : [];
  });
  if (!candidates.length) {
    return new Map();
  }
  const paths = candidates.map((entry) => entry.path);
  let head: string | undefined;
  try {
    head = (await runGit(parent.worktreePath, [
      'rev-parse',
      '--verify',
      '--quiet',
      'HEAD',
    ], { signal })).trim();
  } catch (error: unknown) {
    signal?.throwIfAborted();
    if ((error as { code?: number }).code !== 1) {
      throw error;
    }
  }
  const [index, committed, initialized] = await Promise.all([
    runGit(parent.worktreePath, [
      'ls-files',
      '--stage',
      '-z',
      '--',
      ...paths,
    ], { signal }),
    head
      ? runGit(parent.worktreePath, [
        'ls-tree',
        '-r',
        '-z',
        head,
        '--',
        ...paths,
      ], { signal })
      : '',
    Promise.all(candidates.map((entry) => hasWorktree(entry.child.worktreePath))),
  ]);
  const gitlinks = new Set((index + committed).split('\0')
    .filter((entry) => entry.startsWith('160000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1)));
  const blockers = new Map<string, WorkspaceError>();
  for (const [index, entry] of candidates.entries()) {
    if (gitlinks.has(entry.path) || initialized[index]) {
      blockers.set(entry.path, new WorkspaceError(
        `子项目 ${entry.child.name} 已停用，不能暂存或提交其子模块指针 ${entry.path}。`,
        409,
      ));
    }
  }
  return blockers;
}

export function projectPointerCommitBlocker(
  state: ChangesSnapshot,
  blockers: ReadonlyMap<string, Error>,
) {
  return state.staged.map((file) => indexStageBlocker(file, blockers)).find(Boolean);
}

/** Keep Git facts intact; add workspace-specific restrictions to their presentation. */
export function applyProjectEnablementStatus<T extends ChangesSnapshot>(
  project: WorkspaceProject,
  state: T,
  blockers: ReadonlyMap<string, Error>,
): T {
  const reason = !project.enabled
    ? `${project.name} 已停用，不参与工作区提交。`
    : projectPointerCommitBlocker(state, blockers)?.message;
  return {
    ...state,
    unstaged: state.unstaged.map((file): GitFileChange => ({
      ...file,
      stageBlockedReason: file.stageBlockedReason ?? indexStageBlocker(file, blockers)?.message,
    })),
    commitBlockedReason: reason ?? state.commitBlockedReason,
    amendBlockedReason: reason ?? state.amendBlockedReason,
  };
}

/** Serialize disabling with affected Git writes, including available ancestor indices. */
export async function withProjectDisableCheck<T>(
  document: WorkspaceDocument,
  project: WorkspaceProject,
  apply: (reasons: string[]) => Promise<T>,
) {
  const scope = document.projects.filter((candidate) => candidate.id === project.id
    || childPath(candidate, project) !== undefined);
  const indices = await Promise.all(scope.map(async (candidate) => {
    try {
      return { project: candidate, path: await gitIndexPath(candidate.worktreePath) };
    } catch (error: unknown) {
      return { project: candidate, error: String(error) };
    }
  }));
  return withGitIndices(indices.flatMap((entry) => entry.path ? [entry.path] : []), async () => {
    const reasons: string[] = [];
    for (const entry of indices) {
      if (entry.error) {
        reasons.push(`无法检查 ${entry.project.name}：${entry.error}`);
        continue;
      }
      try {
        const state = await readChangesSnapshot(entry.project.worktreePath, {
          indexPath: entry.path,
        });
        if (entry.project.id === project.id) {
          if (!project.baseline || !state.head) {
            reasons.push('无法确认 HEAD 与基线一致。');
          } else if (state.head !== project.baseline.commit) {
            reasons.push('HEAD 与保存的基线不一致。');
          }
          if (state.staged.length || state.unstaged.length) {
            reasons.push('工作树存在未提交的修改。');
          }
        } else if (state.staged.length) {
          const blockers = await readDisabledSubmodulePointers(entry.project, [project]);
          if (projectPointerCommitBlocker(state, blockers)) {
            reasons.push(`父项目 ${entry.project.name} 已暂存对应子模块指针，停用后需要先取消暂存该指针。`);
          }
        }
      } catch (error: unknown) {
        reasons.push(`无法检查 ${entry.project.name}：${String(error)}`);
      }
    }
    return apply(reasons);
  });
}
