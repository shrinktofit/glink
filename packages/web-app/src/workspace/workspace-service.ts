import {
  worktreeDeletionPath,
  type WorktreeDeletionPlan,
  type WorktreeDeletionResult,
  type WorktreeDeletionEvent,
  type WorktreeDeletionProgress,
  type WorktreePreflightEvent,
  type WorktreePreflightProgress,
} from '@glink/protocol/git';
import type { FileDiffResponse, GitIndexAction, GitReferenceOption } from '@glink/protocol/git';
import {
  glinkStatePath,
  workspacesPath,
  type CreateWorkspaceInput,
  type GlinkCatalog,
  type UpdateProjectInput,
  type WorkspaceCommit,
  type WorkspaceCommitInput,
  type WorkspaceCommitResult,
  type WorkspaceDocument,
  type WorkspaceProjectStatus,
  type WorkspaceChangesSnapshot,
  type BaselineRefComparison,
  type ProjectBaseline,
} from '@glink/protocol/workspace';
import { ProjectDisableConfirmationError } from './project-disable-confirmation-error';

export class WorkspaceService {
  static catalog(signal?: AbortSignal) {
    return WorkspaceService._request<GlinkCatalog>(glinkStatePath, 'GET', undefined, signal);
  }

  constructor(readonly home: string) {}

  catalog(signal?: AbortSignal) {
    return WorkspaceService.catalog(signal);
  }

  async planWorktreeDeletion(
    worktreePath: string, onProgress: (progress: WorktreePreflightProgress) => void,
    signal: AbortSignal,
  ): Promise<WorktreeDeletionPlan> {
    const response = await fetch(`${worktreeDeletionPath}/preflight`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreePath }),
    });
    const interrupted = '预检连接提前结束，请重新检查。';
    let plan: WorktreeDeletionPlan | undefined;
    for await (const event of WorkspaceService._readEvents<WorktreePreflightEvent>(
      response, interrupted,
    )) {
      if ('progress' in event) {
        onProgress(event.progress);
      } else if ('plan' in event) {
        plan = event.plan;
      } else {
        throw new Error(event.error);
      }
    }
    if (!plan) {
      throw new Error(interrupted);
    }
    return plan;
  }

  async deleteWorktree(
    token: string, onProgress: (progress: WorktreeDeletionProgress) => void,
  ): Promise<WorktreeDeletionResult> {
    const interrupted = '删除进度连接已中断，结果未知。请检查工作树和工作区状态后重新预检，勿直接重复删除。';
    const response = await fetch(`${worktreeDeletionPath}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/x-ndjson' },
      body: JSON.stringify({ token }),
    }).catch((cause: unknown) => {
      throw new Error(interrupted, { cause });
    });
    let result: WorktreeDeletionResult | undefined;
    for await (const event of WorkspaceService._readEvents<WorktreeDeletionEvent>(
      response, interrupted,
    )) {
      if ('progress' in event) {
        onProgress(event.progress);
      } else if ('result' in event) {
        result = event.result;
      } else {
        throw new Error(event.error);
      }
    }
    if (!result) {
      throw new Error(interrupted);
    }
    return result;
  }

  retryDeletionRecordCleanup(token: string) {
    return WorkspaceService._request<Pick<WorktreeDeletionResult, 'recordErrors'>>(
      `${worktreeDeletionPath}/cleanup`, 'POST', { token },
    );
  }

  get(id: string, signal?: AbortSignal) {
    return this._request<WorkspaceDocument>(id, '', 'GET', undefined, signal);
  }

  create(input: CreateWorkspaceInput) {
    return WorkspaceService._request<WorkspaceDocument>(workspacesPath, 'POST', input);
  }

  remove(id: string) {
    return this._request(id, '', 'DELETE');
  }

  addProject(id: string, worktreePath: string, parentId?: string) {
    return this._request<WorkspaceDocument>(id, '/projects', 'POST', { worktreePath, parentId });
  }

  updateProject(id: string, projectId: string, input: UpdateProjectInput) {
    return this._request<WorkspaceDocument>(
      id,
      `/projects/${encodeURIComponent(projectId)}`,
      'PATCH',
      input,
    );
  }

  setProjectEnabled(id: string, projectId: string, enabled: boolean, confirmDisable?: boolean) {
    return this._request<WorkspaceDocument>(
      id,
      `/projects/${encodeURIComponent(projectId)}/enabled`,
      'POST',
      { enabled, confirmDisable },
    );
  }

  references(id: string, projectId: string, signal?: AbortSignal) {
    return this._request<GitReferenceOption[]>(id,
      `/projects/${encodeURIComponent(projectId)}/references`,
      'GET',
      undefined,
      signal);
  }

  compareBaseline(
    id: string,
    projectId: string,
    baseline: ProjectBaseline & { ref: string },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ commit: baseline.commit, ref: baseline.ref });
    return this._request<BaselineRefComparison>(
      id,
      `/projects/${encodeURIComponent(projectId)}/baseline-comparison?${query}`,
      'GET',
      undefined,
      signal,
    );
  }

  removeProject(id: string, projectId: string) {
    return this._request<WorkspaceDocument>(
      id,
      `/projects/${encodeURIComponent(projectId)}`,
      'DELETE',
    );
  }

  status(id: string, options: { projectIds?: readonly string[]; signal?: AbortSignal } = {}) {
    const query = new URLSearchParams();
    for (const projectId of options.projectIds ?? []) {
      query.append('projectId', projectId);
    }
    return this._request<WorkspaceProjectStatus[]>(
      id, `/status?${query}`, 'GET', undefined, options.signal,
    );
  }

  history(id: string, projectIds: readonly string[], signal?: AbortSignal) {
    const query = new URLSearchParams();
    for (const projectId of projectIds) {
      query.append('projectId', projectId);
    }
    return this._request<{
      commits: WorkspaceCommit[];
      errors: Array<{ projectId: string; error: string }>;
    }>(id, `/commits?${query}`, 'GET', undefined, signal);
  }

  diff(id: string, projectId: string, path: string, staged: boolean, signal?: AbortSignal) {
    const query = new URLSearchParams({ projectId, path, staged: String(staged) });
    return this._request<FileDiffResponse>(id, `/diff?${query}`, 'GET', undefined, signal);
  }

  changeIndex(id: string, projectId: string, path: string, action: GitIndexAction) {
    return this._request<WorkspaceChangesSnapshot>(id, '/index', 'POST', {
      projectId,
      path,
      action,
    });
  }

  changeAllIndex(id: string, projectId: string, action: GitIndexAction, directory?: string) {
    return this._request<WorkspaceChangesSnapshot>(id, '/index-all', 'POST', {
      projectId,
      action,
      directory,
    });
  }

  changeIndexPaths(
    id: string,
    projectId: string,
    paths: readonly string[],
    action: GitIndexAction,
  ) {
    return this._request<WorkspaceChangesSnapshot>(id, '/index-paths', 'POST', {
      projectId,
      paths,
      action,
    });
  }

  commit(id: string, input: WorkspaceCommitInput) {
    return this._request<WorkspaceCommitResult>(id, '/commit', 'POST', input);
  }

  private static async* _readEvents<T>(response: Response, interrupted: string) {
    if (!response.ok) {
      throw new Error((await response.json() as { error: string }).error);
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, newline)) as T;
          buffer = buffer.slice(newline + 1);
          yield event;
        }
        if (done) {
          break;
        }
      }
    } catch (cause: unknown) {
      throw new Error(interrupted, { cause });
    } finally {
      reader.releaseLock();
    }
    if (buffer.trim()) {
      throw new Error(interrupted);
    }
  }

  private static async _request<T>(
    path: string,
    method = 'GET',
    input?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(path, {
      method,
      signal,
      headers: input === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const value = await response.json();
    if (!response.ok) {
      if (value.disableConfirmation) {
        throw new ProjectDisableConfirmationError(value.error, value.disableConfirmation);
      }
      throw new Error(value.error ?? `Request failed (${response.status}).`);
    }
    return value as T;
  }

  private _request<T>(
    id: string,
    suffix = '',
    method = 'GET',
    input?: unknown,
    signal?: AbortSignal,
  ) {
    return WorkspaceService._request<T>(
      `${workspacesPath}/${encodeURIComponent(id)}${suffix}`,
      method,
      input,
      signal,
    );
  }
}
