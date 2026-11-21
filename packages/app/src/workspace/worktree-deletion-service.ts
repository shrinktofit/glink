import {
  WorktreePreflightCheck,
  WorktreePreflightState,
  WorktreeDeletionPhase,
  type WorktreeDeletionProgress,
  type WorktreePreflightProgress,
} from '@glink/protocol/git';
import { randomUUID } from 'node:crypto';
import type { WorktreeDeletionPlan, WorktreeDeletionResult } from '@glink/protocol/git';
import type { WorkspaceDocument } from '@glink/protocol/workspace';
import {
  containsPath,
  deleteWorktree,
  inspectRemoval,
  pathIdentity,
  WorktreeRemovalError,
  type RemovalTarget,
} from '../git/worktree-removal.ts';
import { withGitIndices } from '../git/index-queue.ts';
import { WorkspaceStore } from './workspace-store.ts';

interface PreparedDeletion {
  plan: WorktreeDeletionPlan;
  targets: RemovalTarget[];
}

export class WorktreeDeletionService {
  constructor(store: WorkspaceStore) {
    this._store = store;
  }

  async plan(
    path: string, onProgress?: (progress: WorktreePreflightProgress) => void, signal?: AbortSignal,
  ) {
    let active = WorktreePreflightCheck.topology;
    const report = (progress: WorktreePreflightProgress) => {
      if (progress.state === WorktreePreflightState.inProgress) {
        active = progress.id;
      }
      onProgress?.(progress);
    };
    try {
      if (typeof path !== 'string' || !path) {
        throw new WorktreeRemovalError('worktreePath is required.');
      }
      const prepared = await this._prepare(path, report, signal);
      prepared.plan.token = randomUUID();
      // Bound abandoned confirmations without storing any destructive capability on disk.
      if (this._plans.size >= 100) {
        this._plans.delete(this._plans.keys().next().value!);
      }
      this._plans.set(prepared.plan.token, prepared);
      return prepared.plan;
    } catch (error: unknown) {
      if (!signal?.aborted) {
        report({ id: active, state: WorktreePreflightState.error, detail: String(error) });
      }
      throw error;
    }
  }

  async safeDeleteWorktree(
    token: string, onProgress?: (progress: WorktreeDeletionProgress) => void,
  ): Promise<WorktreeDeletionResult> {
    const prepared = this._plans.get(token);
    if (!prepared) {
      throw new WorktreeRemovalError('删除计划已失效，请重新确认。');
    }
    this._plans.delete(token);
    let completed = 0;
    const report = (phase: WorktreeDeletionPhase, worktreePath?: string, detail?: string) => {
      onProgress?.({
        phase,
        worktreePath,
        detail,
        completed,
        total: prepared.targets.length,
      });
    };
    report(WorktreeDeletionPhase.queued);
    return this._store.mutate(() => withGitIndices(
      prepared.targets.map((target) => target.indexPath), async () => {
        report(WorktreeDeletionPhase.revalidate);
        const current = await this._prepare(prepared.plan.worktreePath);
        const sameScope = current.targets.length === prepared.targets.length
          && current.targets.every((target, index) => {
            const previous = prepared.targets[index];
            return target.main === previous.main
              && ([
                'path',
                'gitDir',
                'commonDir',
                'indexPath',
              ] as const).every((key) =>
                pathIdentity(target[key]) === pathIdentity(previous[key]));
          });
        if (!sameScope) {
          throw new WorktreeRemovalError('工作树或 Git 数据的删除范围已变化，请重新确认。');
        }
        if (current.targets.some((target, index) => {
          const previous = prepared.targets[index];
          return target.head !== previous.head
            || (previous.survivingRefs.length > 0 && target.survivingRefs.length === 0);
        })) {
          throw new WorktreeRemovalError('工作树 HEAD 或提交保留情况已变化，请重新确认。');
        }
        const references = current.plan.references;
        if (references.length !== prepared.plan.references.length
          || references.some((reference, index) => {
            const previous = prepared.plan.references[index];
            return reference.workspaceId !== previous.workspaceId
              || reference.projectId !== previous.projectId
              || pathIdentity(reference.worktreePath) !== pathIdentity(previous.worktreePath);
          })) {
          throw new WorktreeRemovalError('引用此删除范围的工作区项目已变化，请重新确认。');
        }
        const result: WorktreeDeletionResult = {
          deleted: [],
          remaining: current.targets.map((target) => target.path),
          recordErrors: [],
        };
        for (const target of current.targets) {
          try {
            await deleteWorktree(target, (phase) => report(phase, target.path));
            result.deleted.push(target.path);
            result.remaining.shift();
            completed++;
            report(WorktreeDeletionPhase.deleted, target.path);
          } catch (error: unknown) {
            result.failed = { path: target.path, error: String(error) };
            report(WorktreeDeletionPhase.failed, target.path, result.failed.error);
            break;
          }
        }
        report(WorktreeDeletionPhase.records);
        result.recordErrors = await this._forget(result.deleted);
        if (result.recordErrors.length) {
          const cleanupToken = randomUUID();
          this._recordCleanup.set(cleanupToken, result.deleted);
          result.cleanupToken = cleanupToken;
        }
        return result;
      },
    ));
  }

  retryRecordCleanup(token: string) {
    return this._store.mutate(async () => {
      const paths = this._recordCleanup.get(token);
      if (!paths) {
        throw new WorktreeRemovalError('记录清理请求不存在。');
      }
      const recordErrors = await this._forget(paths);
      if (!recordErrors.length) {
        this._recordCleanup.delete(token);
      }
      return { recordErrors };
    });
  }

  private readonly _store: WorkspaceStore;
  private readonly _plans = new Map<string, PreparedDeletion>();
  private readonly _recordCleanup = new Map<string, string[]>();

  private async _prepare(
    path: string, report?: (progress: WorktreePreflightProgress) => void, signal?: AbortSignal,
  ): Promise<PreparedDeletion> {
    report?.({ id: WorktreePreflightCheck.topology, state: WorktreePreflightState.inProgress });
    const targets = await inspectRemoval(path, signal);
    if (targets.some((target) => containsPath(target.path, this._store.home))) {
      throw new WorktreeRemovalError('删除范围包含 Glink Home，不能删除。');
    }
    report?.({ id: WorktreePreflightCheck.topology, state: WorktreePreflightState.ok });
    report?.({ id: WorktreePreflightCheck.references, state: WorktreePreflightState.inProgress });
    const catalog = await this._store.catalog();
    const documents: WorkspaceDocument[] = [];
    for (const workspace of catalog.workspaces) {
      signal?.throwIfAborted();
      documents.push(await this._store.get(workspace.id));
    }
    const references: WorktreeDeletionPlan['references'] = [];
    for (const document of documents) {
      const included = new Set(document.projects.filter((project) => targets.some((target) =>
        containsPath(target.path, project.worktreePath),
      )).map((project) => project.id));
      for (const edge of document.connections) {
        if (included.has(edge.to) && !included.has(edge.from)) {
          const parent = this._store.project(document, edge.from);
          const child = this._store.project(document, edge.to);
          throw new WorktreeRemovalError(
            `工作区「${document.name}」中的项目「${parent.name}」`
            + `仍依赖项目「${child.name}」，不能删除工作树。`,
          );
        }
      }
      for (const project of document.projects.filter((project) => included.has(project.id))) {
        references.push({
          workspaceId: document.id,
          workspaceName: document.name,
          projectId: project.id,
          projectName: project.name,
          worktreePath: project.worktreePath,
        });
      }
    }
    // Saving any workspace can reorder the catalog without changing deletion authorization.
    references.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)
      || a.projectId.localeCompare(b.projectId));
    report?.({ id: WorktreePreflightCheck.references, state: WorktreePreflightState.ok });
    report?.({ id: WorktreePreflightCheck.review, state: WorktreePreflightState.inProgress });
    const warnings = targets.flatMap((target) => [
      ...(target.main ? [`${target.path}：将删除本地仓库数据。`] : []),
      ...(target.changes ? [`${target.path}：存在未提交或未跟踪的修改。`] : []),
      ...(!target.main && target.head && !target.survivingRefs.length
        ? [`${target.path}：当前提交没有删除后仍保留的引用，可能丢失。`]
        : []),
    ]);
    report?.({ id: WorktreePreflightCheck.review,
      state: warnings.length ? WorktreePreflightState.warn : WorktreePreflightState.ok,
      detail: warnings.length ? warnings.join('\n') : undefined });
    return {
      targets,
      plan: {
        token: '',
        worktreePath: path,
        worktrees: targets.map(({
          path,
          main,
          branch,
          head,
          survivingRefs,
          detached,
          changes,
        }) =>
          ({
            path,
            main,
            branch,
            head,
            survivingRefs,
            detached,
            changes,
          })),
        references,
      },
    };
  }

  private async _forget(paths: string[]) {
    const errors: WorktreeDeletionResult['recordErrors'] = [];
    if (!paths.length) {
      return errors;
    }
    let catalog;
    try {
      catalog = await this._store.catalog();
    } catch (error: unknown) {
      return [{ workspaceId: 'state.yaml', error: String(error) }];
    }
    for (const workspace of catalog.workspaces) {
      try {
        await this._store.forgetDeletedWorktrees(await this._store.get(workspace.id), paths);
      } catch (error: unknown) {
        errors.push({ workspaceId: workspace.id, error: String(error) });
      }
    }
    return errors;
  }
}
