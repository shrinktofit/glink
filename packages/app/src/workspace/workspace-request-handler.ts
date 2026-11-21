import { toolsPath } from '@glink/protocol/tools';
import { executeWorkspaceTool } from '../tools/workspace-tools.ts';
import { WorktreeDeletionService } from './worktree-deletion-service.ts';
import { WorktreeRemovalError } from '../git/worktree-removal.ts';
import {
  worktreeDeletionPath,
  type WorktreePreflightEvent,
  type WorktreeDeletionEvent,
} from '@glink/protocol/git';
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
  type PatchProjectInput,
} from '@glink/protocol/workspace';
import { readFileDiff } from '../git/worktree.ts';
import { changeWorkspaceIndex } from './workspace-index.ts';
import { ProjectDisableConfirmationError } from './project-disable-confirmation-error.ts';
import { handleRequest } from '../request-handler.ts';
import { commitWorkspace, workspaceHistory, workspaceStatuses } from './workspace-operations.ts';
import { WorkspaceStore } from './workspace-store.ts';
import { WorkspaceError } from './workspace-error.ts';
import { readBaselineComparison, readProjectReferences } from './project-references.ts';
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
  const deletion = new WorktreeDeletionService(store);

  function sendErrorResponse(response: ServerResponse, error: unknown) {
    if (response.destroyed) {
      return;
    }

    let status = 500;

    if (error instanceof WorkspaceError || error instanceof WorktreeRemovalError) {
      status = error.status;
    } else if (error instanceof GitIndexLockedError || error instanceof GitSubmoduleDirtyError) {
      status = 409;
    }

    const message = error instanceof Error ? error.message : String(error);

    response
      .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({
        error: message,
        ...(error instanceof ProjectDisableConfirmationError
          ? { disableConfirmation: error.confirmation }
          : {}),
      }));
  }

  async function toolRequest(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    const name = decodeURIComponent(url.pathname.slice(toolsPath.length + 1));
    const input = await body<unknown>(request);
    const result = await executeWorkspaceTool(store, name, input);

    response
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify(result));
  }

  async function readRequestedProjects(id: string, url: URL) {
    const document = await store.get(id);
    const ids = [...new Set(url.searchParams.getAll('projectId'))];
    const projects = ids.length ? ids.map((id) => store.project(document, id)) : document.projects;
    return { document, projects };
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
    if (url.pathname === `${worktreeDeletionPath}/preflight` && method === 'POST') {
      const input = await body<{ worktreePath: string }>(request);
      const cancellation = readRequestSignal(response);
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const send = (event: WorktreePreflightEvent) => {
        if (!response.destroyed) {
          response.write(JSON.stringify(event) + '\n');
        }
      };
      try {
        const plan = await deletion.plan(input.worktreePath,
          (progress) => send({ progress }),
          cancellation);
        send({ plan });
      } catch (error: unknown) {
        if (!cancellation.aborted) {
          send({ error: String(error) });
        }
      }
      response.end();
      return;
    }
    if (url.pathname === `${worktreeDeletionPath}/execute` && method === 'POST'
      && request.headers.accept?.includes('application/x-ndjson')) {
      const input = await body<{ token: string }>(request);
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const send = (event: WorktreeDeletionEvent) => {
        if (!response.destroyed && !response.writableEnded) {
          response.write(JSON.stringify(event) + '\n');
        }
      };
      try {
        // Disconnecting the progress stream must not cancel an accepted deletion.
        const result = await deletion.safeDeleteWorktree(input.token,
          (progress) => send({ progress }));
        send({ result });
      } catch (error: unknown) {
        send({ error: error instanceof Error ? error.message : String(error) });
      }
      response.end();
      return;
    }
    let result: unknown;
    if (url.pathname.startsWith(`${worktreeDeletionPath}/`) && method === 'POST') {
      const input = await body<{ worktreePath: string; token: string }>(request);
      if (url.pathname === `${worktreeDeletionPath}/plan`) {
        result = await deletion.plan(input.worktreePath);
      } else if (url.pathname === `${worktreeDeletionPath}/execute`) {
        result = await deletion.safeDeleteWorktree(input.token);
      } else if (url.pathname === `${worktreeDeletionPath}/cleanup`) {
        result = await deletion.retryRecordCleanup(input.token);
      } else {
        throw new WorkspaceError('Endpoint not found.', 404);
      }
    } else if (url.pathname === glinkStatePath && method === 'GET') {
      result = await store.catalog();
    } else if (!id && method === 'POST') {
      result = await store.create(await body<CreateWorkspaceInput>(request));
    } else if (id && !section && method === 'GET') {
      result = await store.synchronize(id);
    } else if (id && !section && method === 'DELETE') {
      await store.remove(id);
      result = {};
    } else if (id && section === 'projects' && projectId
      && parts[3] === 'references' && method === 'GET') {
      result = await readProjectReferences(store.project(await store.get(id), projectId), signal);
    } else if (id && section === 'projects' && projectId
      && parts[3] === 'baseline-comparison' && method === 'GET') {
      result = await readBaselineComparison(store.project(await store.get(id), projectId), {
        commit: url.searchParams.get('commit') ?? '',
        ref: url.searchParams.get('ref') ?? '',
      }, signal);
    } else if (id && section === 'projects' && projectId
      && parts[3] === 'enabled' && method === 'POST') {
      const input = await body<Pick<PatchProjectInput, 'enabled' | 'confirmDisable'>>(request);
      if (typeof input.enabled !== 'boolean') {
        throw new WorkspaceError('enabled must be a boolean.');
      }
      result = await store.patchProject(id, projectId, input);
    } else if (id && section === 'projects' && method === 'POST' && !projectId) {
      const input = await body<{ worktreePath: string; parentId?: string }>(request);
      result = await store.addProject(id, input.worktreePath, input.parentId);
    } else if (id && section === 'projects' && projectId && method === 'PATCH') {
      result = await store.updateProject(id, projectId, await body<UpdateProjectInput>(request));
    } else if (id && section === 'projects' && projectId && method === 'DELETE') {
      result = await store.removeProject(id, projectId);
    } else if (id && section === 'status' && method === 'GET') {
      const { document, projects } = await readRequestedProjects(id, url);
      result = await workspaceStatuses(document, projects, signal);
    } else if (id && section === 'commits' && method === 'GET') {
      result = await workspaceHistory((await readRequestedProjects(id, url)).projects, signal);
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
      result = await changeWorkspaceIndex(store, id, input.projectId, (index, blockers) => {
        return index.changeAll(input.action, input.directory, blockers);
      });
    } else if (id && section === 'index-paths' && method === 'POST') {
      const input = await body<{
        projectId: string;
        paths: string[];
        action: GitIndexAction;
      }>(request);
      if (!Object.values(GitIndexAction).includes(input.action)
        || !Array.isArray(input.paths) || !input.paths.length
        || !input.paths.every((path) => typeof path === 'string' && path.length > 0)) {
        throw new WorkspaceError('paths and a valid index action are required.');
      }
      result = await changeWorkspaceIndex(store, id, input.projectId, (index, blockers) => {
        return index.changePaths(input.paths, input.action, blockers);
      });
    } else if (id && section === 'index' && method === 'POST') {
      const input = await body<{ projectId: string; path: string; action: GitIndexAction }>(
        request,
      );
      if (!Object.values(GitIndexAction).includes(input.action)) {
        throw new WorkspaceError('Invalid index action.');
      }
      result = await changeWorkspaceIndex(store, id, input.projectId, (index, blockers) => {
        return index.change(input.path, input.action, blockers);
      });
    } else {
      throw new WorkspaceError('Workspace endpoint not found.', 404);
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify(result));
  }

  return (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === toolsPath || url.pathname.startsWith(`${toolsPath}/`)) {
      toolRequest(request, response, url).catch((error: unknown) => {
        sendErrorResponse(response, error);
      });

      return;
    }
    if (
      !url.pathname.startsWith(`${worktreeDeletionPath}/`)
      && url.pathname !== glinkStatePath
      && url.pathname !== workspacesPath
      && !url.pathname.startsWith(`${workspacesPath}/`)
    ) {
      handleRequest(request, response);
      return;
    }
    workspaceRequest(request, response, url).catch((error: unknown) => {
      sendErrorResponse(response, error);
    });
  };
}
