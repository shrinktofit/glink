import { readRequestSignal } from '../read-request-signal.ts';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GitIndexAction } from '@glink/protocol/git';
import {
  glinkStatePath,
  workspacesPath,
  type CreateWorkspaceInput,
  type UpdateProjectInput,
  type WorkspaceCommitInput,
} from '@glink/protocol/workspace';
import { changeAllIndex, changeIndex, readFileDiff } from '../git/worktree.ts';
import { handleRequest } from '../request-handler.ts';
import { commitWorkspace, workspaceHistory, workspaceStatuses } from './workspace-operations.ts';
import { WorkspaceError, WorkspaceStore } from './workspace-store.ts';
import { readProjectBranches } from './workspace-git.ts';
import { GitIndexLockedError } from '../git/git-index-locked-error.ts';
import { GitSubmoduleDirtyError } from '../git/git-submodule-dirty-error.ts';

async function body<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new WorkspaceError('Request body is too large.', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new WorkspaceError('Invalid JSON request.');
  }
}

export async function createGlinkRequestHandler(options: { glinkHome: string }) {
  const store = await WorkspaceStore.open(options.glinkHome);

  async function readRequestedProjects(id: string, url: URL) {
    const document = await store.get(id);
    const ids = [...new Set(url.searchParams.getAll('projectId'))];
    return ids.length ? ids.map((id) => store.project(document, id)) : document.projects;
  }

  async function workspaceRequest(request: IncomingMessage, response: ServerResponse, url: URL) {
    const parts = url.pathname
      .slice(workspacesPath.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    const [id, section, projectId] = parts;
    const method = request.method;
    const signal = method === 'GET' ? readRequestSignal(response) : undefined;
    let result: unknown;
    if (url.pathname === glinkStatePath && method === 'GET') {
      result = await store.catalog();
    } else if (!id && method === 'POST') {
      result = await store.create(await body<CreateWorkspaceInput>(request));
    } else if (id && !section && method === 'GET') {
      result = await store.synchronize(id);
    } else if (id && !section && method === 'DELETE') {
      await store.remove(id);
      result = {};
    } else if (id && section === 'projects' && projectId
      && parts[3] === 'branches' && method === 'GET') {
      result = await readProjectBranches(store.project(await store.get(id), projectId));
    } else if (id && section === 'projects' && method === 'POST' && !projectId) {
      const input = await body<{ worktreePath: string; parentId?: string }>(request);
      result = await store.addProject(id, input.worktreePath, input.parentId);
    } else if (id && section === 'projects' && projectId && method === 'PATCH') {
      result = await store.updateProject(id, projectId, await body<UpdateProjectInput>(request));
    } else if (id && section === 'projects' && projectId && method === 'DELETE') {
      result = await store.removeProject(id, projectId);
    } else if (id && section === 'status' && method === 'GET') {
      result = await workspaceStatuses(await readRequestedProjects(id, url), signal);
    } else if (id && section === 'commits' && method === 'GET') {
      result = await workspaceHistory(await readRequestedProjects(id, url), signal);
    } else if (id && section === 'commit' && method === 'POST') {
      result = await commitWorkspace(store, id, await body<WorkspaceCommitInput>(request));
    } else if (id && section === 'diff' && method === 'GET') {
      const project = store.project(await store.get(id), url.searchParams.get('projectId') ?? '');
      result = await readFileDiff(
        project.worktreePath,
        url.searchParams.get('path') ?? '',
        url.searchParams.get('staged') === 'true',
        signal,
      );
    } else if (id && section === 'index-all' && method === 'POST') {
      const input = await body<{
        projectId: string;
        action: GitIndexAction;
        directory?: string;
      }>(request);
      if (!Object.values(GitIndexAction).includes(input.action)) {
        throw new WorkspaceError('Invalid index action.');
      }
      if (input.directory !== undefined
        && (typeof input.directory !== 'string' || !input.directory)) {
        throw new WorkspaceError('Invalid directory.');
      }
      const project = store.project(await store.get(id), input.projectId);
      result = {
        ...await changeAllIndex(project.worktreePath, input.action, input.directory),
        projectId: project.id,
        baseCommit: project.baseCommit,
      };
    } else if (id && section === 'index' && method === 'POST') {
      const input = await body<{ projectId: string; path: string; action: GitIndexAction }>(
        request,
      );
      if (!Object.values(GitIndexAction).includes(input.action)) {
        throw new WorkspaceError('Invalid index action.');
      }
      const project = store.project(await store.get(id), input.projectId);
      result = {
        ...await changeIndex(project.worktreePath, input.path, input.action),
        projectId: project.id,
        baseCommit: project.baseCommit,
      };
    } else {
      throw new WorkspaceError('Workspace endpoint not found.', 404);
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify(result));
  }

  return (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (
      url.pathname !== glinkStatePath
      && url.pathname !== workspacesPath
      && !url.pathname.startsWith(`${workspacesPath}/`)
    ) {
      handleRequest(request, response);
      return;
    }
    workspaceRequest(request, response, url).catch((error: unknown) => {
      if (response.destroyed) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      response
        .writeHead(error instanceof WorkspaceError
          ? error.status
          : error instanceof GitIndexLockedError || error instanceof GitSubmoduleDirtyError
            ? 409
            : 500, {
          'Content-Type': 'application/json; charset=utf-8',
        })
        .end(JSON.stringify({ error: message }));
    });
  };
}
