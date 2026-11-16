import {
  WorktreePreflightCheck,
  WorktreePreflightState,
  type WorktreePreflightProgress,
} from '@glink/protocol/git';
import { createHash, randomUUID } from 'node:crypto';
import type { WorktreeDeletionPlan, WorktreeDeletionResult } from '@glink/protocol/git';
import type { WorkspaceDocument } from '@glink/protocol/workspace';
import {
  containsPath,
  deleteWorktree,
  inspectRemoval,
  WorktreeRemovalError,
  type RemovalTarget,
} from '../git/worktree-removal.ts';
import { withGitIndices } from '../git/index-queue.ts';
import { WorkspaceStore } from './workspace-store.ts';

interface PreparedDeletion {
  plan: WorktreeDeletionPlan;
  targets: RemovalTarget[];
  signature: string;
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

  async safeDeleteWorktree(token: string): Promise<WorktreeDeletionResult> {
    const prepared = this._plans.get(token);
    if (!prepared) {
      throw new WorktreeRemovalError('删除计划已失效，请重新确认。');
    }
    this._plans.delete(token);
    return this._store.mutate(() => withGitIndices(
      prepared.targets.map((target) => target.indexPath), async () => {
        const current = await this._prepare(prepared.plan.worktreePath);
        if (current.signature !== prepared.signature) {
          throw new WorktreeRemovalError('删除范围、文件或工作区状态已变化，请重新确认。');
        }
        const result: WorktreeDeletionResult = {
          deleted: [],
          remaining: current.targets.map((target) => target.path),
          recordErrors: [],
        };
        for (const target of current.targets) {
          try {
            await deleteWorktree(target);
            result.deleted.push(target.path);
            result.remaining.shift();
          } catch (error: unknown) {
            result.failed = { path: target.path, error: String(error) };
            break;
          }
        }
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
    const targets = await inspectRemoval(path, () => {
      report?.({ id: WorktreePreflightCheck.topology, state: WorktreePreflightState.ok });
      report?.({ id: WorktreePreflightCheck.files, state: WorktreePreflightState.inProgress });
    }, signal);
    if (targets.some((target) => containsPath(target.path, this._store.home))) {
      throw new WorktreeRemovalError('删除范围包含 Glink Home，不能删除。');
    }
    report?.({ id: WorktreePreflightCheck.files, state: WorktreePreflightState.ok });
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
            `${document.name} / ${parent.name} 仍依赖 ${child.name}，不能删除工作树。`,
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
    report?.({ id: WorktreePreflightCheck.references, state: WorktreePreflightState.ok });
    report?.({ id: WorktreePreflightCheck.review, state: WorktreePreflightState.inProgress });
    const warnings = targets.flatMap((target) => [
      ...(target.main ? [`${target.path}：将删除本地仓库数据。`] : []),
      ...(target.changes ? [`${target.path}：存在未提交或未跟踪的修改。`] : []),
      ...(target.detached ? [`${target.path}：Detached HEAD 提交可能失去持久引用。`] : []),
    ]);
    report?.({ id: WorktreePreflightCheck.review,
      state: warnings.length ? WorktreePreflightState.warn : WorktreePreflightState.ok,
      detail: warnings.length ? warnings.join('\n') : undefined });
    // The whole catalog participates: an unopened workspace can introduce a new incoming edge.
    const signature = createHash('sha256')
      .update(JSON.stringify({ targets, documents })).digest('hex');
    return {
      targets,
      signature,
      plan: {
        token: '',
        worktreePath: path,
        worktrees: targets.map(({
          path,
          main,
          branch,
          head,
          detached,
          changes,
        }) =>
          ({
            path,
            main,
            branch,
            head,
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
