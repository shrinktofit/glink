import { relative } from 'node:path';
import { GitIndexAction, type GitCommit } from '@glink/protocol/git';
import {
  WorkspaceConnectionKind,
  type WorkspaceCommit,
  type WorkspaceCommitInput,
  type WorkspaceCommitResult,
  type WorkspaceDocument,
  type WorkspaceProjectStatus,
} from '@glink/protocol/workspace';
import { changeIndex, commitWorktree } from '../git/worktree.ts';
import { readProjectCommits, readProjectStatus, runWorkspaceGit } from './workspace-git.ts';
import { WorkspaceError, WorkspaceStore } from './workspace-store.ts';

export async function workspaceStatuses(
  document: WorkspaceDocument,
): Promise<WorkspaceProjectStatus[]> {
  return Promise.all(
    document.projects.map(async (project) => {
      try {
        return await readProjectStatus(project);
      } catch (error: unknown) {
        return {
          projectId: project.id,
          staged: [],
          unstaged: [],
          indexFingerprint: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

export async function workspaceHistory(document: WorkspaceDocument) {
  const errors: Array<{ projectId: string; error: string }> = [];
  const lists = await Promise.all(
    document.projects.map(async (project) => {
      try {
        return (await readProjectCommits(project)).map((commit) => ({
          ...commit,
          projectId: project.id,
        }));
      } catch (error: unknown) {
        errors.push({
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
  );
  // Merge fronts rather than sorting all commits: preserve each repository's topological order.
  const commits: WorkspaceCommit[] = [];
  while (commits.length < 500) {
    let newest: GitCommit | undefined;
    let listIndex = -1;
    lists.forEach((list, index) => {
      if (list[0] && (!newest || list[0].authoredAt > newest.authoredAt)) {
        newest = list[0];
        listIndex = index;
      }
    });
    if (listIndex < 0) {
      break;
    }
    commits.push(lists[listIndex].shift()!);
  }
  return { commits, errors };
}

export async function commitWorkspace(
  store: WorkspaceStore,
  id: string,
  input: WorkspaceCommitInput,
) {
  return store.mutate(async () => {
    if (
      !Array.isArray(input.projectIds)
      || !Array.isArray(input.expected)
      || typeof input.message !== 'string'
      || !input.message.trim()
      || (input.amend !== undefined && typeof input.amend !== 'boolean')
    ) {
      throw new WorkspaceError('Select projects and enter a commit message.');
    }
    const document = await store.get(id);
    const selected = new Set<string>(input.projectIds);
    const snapshots = new Map<string, WorkspaceProjectStatus>();
    for (const projectId of selected) {
      const project = store.project(document, projectId);
      const status = await readProjectStatus(project);
      const expected = input.expected.find((entry) => entry.projectId === projectId);
      if (
        !expected
        || status.head !== expected.head
        || status.indexFingerprint !== expected.indexFingerprint
        || (input.amend && status.baseCommit !== expected.baseCommit)
      ) {
        throw new WorkspaceError(
          `${project.name} changed. Refresh and review its staged changes.`,
          409,
        );
      }
      snapshots.set(projectId, status);
    }
    if (input.amend) {
      // Per-project rules apply to every selection independently of the current count limit.
      for (const [projectId, status] of snapshots) {
        if (status.amendBlockedReason) {
          const project = store.project(document, projectId);
          throw new WorkspaceError(`${project.name}: ${status.amendBlockedReason}`, 409);
        }
      }
      if (selected.size !== 1) {
        throw new WorkspaceError('修订提交目前只能选择一个 Project。', 409);
      }
    }
    const ordered: string[] = [];
    const visited = new Set<string>();

    function visit(projectId: string) {
      if (visited.has(projectId)) {
        return;
      }
      visited.add(projectId);
      document.connections
        .filter((edge) => edge.from === projectId)
        .forEach((edge) => visit(edge.to));
      if (selected.has(projectId)) {
        ordered.push(projectId);
      }
    }

    selected.forEach(visit);
    const result: WorkspaceCommitResult = { committed: [], skipped: [] };
    for (const projectId of ordered) {
      const project = store.project(document, projectId);
      try {
        const before = snapshots.get(projectId)!;
        const current = await readProjectStatus(project);
        if (current.head !== before.head || current.indexFingerprint !== before.indexFingerprint) {
          throw new WorkspaceError(`${project.name} changed during the workspace commit.`, 409);
        }
        for (const edge of document.connections.filter(
          (edge) =>
            edge.from === projectId
            && edge.kind === WorkspaceConnectionKind.submodule
            && result.committed.some((entry) => entry.projectId === edge.to),
        )) {
          const child = store.project(document, edge.to);
          const path = relative(project.worktreePath, child.worktreePath).replaceAll('\\', '/');
          if (current.unstaged.some((file) => file.path === path && file.stageBlockedReason)) {
            continue;
          }
          const indexEntry = await runWorkspaceGit(project.worktreePath, [
            'ls-files',
            '--stage',
            '--',
            path,
          ]);
          if (!indexEntry.startsWith(`160000 ${snapshots.get(child.id)!.head} 0\t`)) {
            throw new WorkspaceError(
              `The staged submodule revision for ${child.name} needs review.`,
              409,
            );
          }
          await changeIndex(project.worktreePath, path, GitIndexAction.stage);
        }
        if (!input.amend && !(await readProjectStatus(project)).staged.length) {
          result.skipped.push(projectId);
          continue;
        }
        await commitWorktree(project.worktreePath, {
          message: input.message.trim(),
          amend: input.amend ?? false,
        });
        const sha = (await runWorkspaceGit(project.worktreePath, ['rev-parse', 'HEAD'])).trim();
        result.committed.push({ projectId, sha });
      } catch (error: unknown) {
        result.failed = {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        };
        break;
      }
    }
    return result;
  });
}
