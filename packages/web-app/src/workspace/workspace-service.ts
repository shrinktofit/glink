import type { FileDiffResponse, GitIndexAction } from '@glink/protocol/git';
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
  type WorkspaceBranch,
} from '@glink/protocol/workspace';

export class WorkspaceService {
  static catalog(signal?: AbortSignal) {
    return WorkspaceService._request<GlinkCatalog>(glinkStatePath, 'GET', undefined, signal);
  }

  constructor(readonly home: string) {}

  catalog(signal?: AbortSignal) {
    return WorkspaceService.catalog(signal);
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

  branches(id: string, projectId: string, signal?: AbortSignal) {
    return this._request<WorkspaceBranch[]>(id,
      `/projects/${encodeURIComponent(projectId)}/branches`,
      'GET',
      undefined,
      signal);
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

  commit(id: string, input: WorkspaceCommitInput) {
    return this._request<WorkspaceCommitResult>(id, '/commit', 'POST', input);
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
