import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { toolsPath } from '@glink/protocol/tools';
import type { WorkspaceDocument } from '@glink/protocol/workspace';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createGlinkRequestHandler } from '../src/workspace/workspace-request-handler.ts';

const execute = promisify(execFile);
const prefix = join(tmpdir(), 'glink-mcp-');

describe('Glink workspace tool API against temporary Git repositories', () => {
  let directory: string;
  let home: string;
  let origin: string;
  let server: Server;

  async function git(path: string, ...args: string[]) {
    const { stdout } = await execute(
      'git',
      [
        '-C',
        path,
        '-c',
        'user.name=Glink Test',
        '-c',
        'user.email=test@glink.local',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );

    return stdout.trim();
  }

  async function repository(name: string) {
    const path = join(directory, name);
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    await writeFile(join(path, 'file.txt'), 'base');
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', 'Base');

    return path;
  }

  function requestTool(name: string, args: Record<string, unknown> = {}) {
    return fetch(`${origin}${toolsPath}/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
  }

  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const response = await requestTool(name, args);
    const result = await response.json() as WorkspaceDocument;

    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  }

  beforeEach(async () => {
    directory = await mkdtemp(prefix);
    home = join(directory, 'home');

    const requestHandler = await createGlinkRequestHandler({ glinkHome: home });
    server = createServer(requestHandler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }

    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((fulfill, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          fulfill();
        }
      });
    });

    if (!directory.startsWith(prefix)) {
      throw new Error('Unexpected fixture path');
    }

    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it('rejects unsupported methods, unknown tools and malformed JSON', async () => {
    /// @case Calls target an unsupported method, a missing tool or an invalid JSON body.
    /// @expect Return 405, 404 and 400 respectively without changing workspace state.
    const method = await fetch(`${origin}${toolsPath}/list_workspaces`);
    expect(method.status).toBe(405);
    expect(method.headers.get('Allow')).toBe('POST');

    const missing = await requestTool('missing_tool');
    expect(missing.status).toBe(404);

    const malformed = await fetch(`${origin}${toolsPath}/list_workspaces`, {
      method: 'POST',
      body: '{',
    });
    expect(malformed.status).toBe(400);

    const catalog = await call('list_workspaces');
    expect(catalog).toEqual({ workspaces: [] });
  });

  it('reads metadata without writes and synchronizes only on request', async () => {
    /// @case A registered worktree gains a Git submodule after the workspace was saved.
    /// @expect Reads leave YAML untouched; explicit sync persists automatic submodule membership.
    const parent = await repository('parent');
    const child = await repository('child');
    const workspace = await call('create_workspace', {
      name: 'MCP',
      worktreePaths: [parent],
    });

    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child');

    const path = join(home, 'workspaces', `${workspace.id}.glink-workspace.yaml`);
    const before = await readFile(path, 'utf8');
    const savedWorkspace = await call('get_workspace', { workspaceId: workspace.id });

    expect(savedWorkspace.projects).toHaveLength(1);

    await call('list_workspaces');
    expect(await readFile(path, 'utf8')).toBe(before);

    const synchronizedWorkspace = await call(
      'sync_workspace',
      { workspaceId: workspace.id },
    );
    expect(synchronizedWorkspace.projects).toHaveLength(2);
  }, 20000);

  it('shares HTTP workspace state and applies concurrent patches atomically', async () => {
    /// @case Two clients update different project fields and later remove workspace memberships.
    /// @expect Preserve untouched fields and Git data; HTTP sees the same persisted document.
    const first = await repository('first');
    const second = await repository('second');

    let workspace = await call('create_workspace', {
      name: 'MCP',
      worktreePaths: [first],
    });

    workspace = await call('add_project', {
      workspaceId: workspace.id,
      worktreePath: second,
      parentId: workspace.projects[0].id,
    });

    const id = workspace.projects[0].id;

    await Promise.all([
      call('update_project', {
        workspaceId: workspace.id,
        projectId: id,
        changes: { settled: true },
      }),
      call('update_project', {
        workspaceId: workspace.id,
        projectId: id,
        changes: { name: 'Renamed' },
      }),
    ]);

    workspace = await call('get_workspace', { workspaceId: workspace.id });

    expect(workspace.projects[0]).toMatchObject({
      name: 'Renamed',
      settled: true,
    });
    expect(workspace.connections).toHaveLength(1);

    await git(first, 'branch', 'alternate');
    workspace = await call('update_project', {
      workspaceId: workspace.id,
      projectId: id,
      changes: {
        binding: {
          kind: 'branch',
          revision: 'refs/heads/alternate',
        },
      },
    });

    expect(workspace.projects[0].binding.revision).toBe('refs/heads/alternate');
    expect(await git(first, 'branch', '--show-current')).toBe('main');

    const sha = await git(first, 'rev-parse', 'HEAD');
    workspace = await call('update_project', {
      workspaceId: workspace.id,
      projectId: id,
      changes: {
        baseline: { commit: sha, ref: 'refs/heads/main' },
        binding: {
          kind: 'commit',
          revision: sha.slice(0, 8),
        },
      },
    });

    expect(workspace.projects[0]).toMatchObject({
      name: 'Renamed',
      settled: true,
      baseline: { commit: sha, ref: 'refs/heads/main' },
      binding: {
        kind: 'commit',
        revision: sha,
      },
    });
    expect(await git(first, 'branch', '--show-current')).toBe('main');

    const response = await fetch(`${origin}/api/workspaces/${workspace.id}`);
    expect(await response.json()).toEqual(workspace);

    const before = await git(first, 'rev-parse', 'HEAD');
    workspace = await call('remove_project', {
      workspaceId: workspace.id,
      projectId: workspace.projects[1].id,
    });

    expect(workspace.projects).toHaveLength(1);

    await call('remove_workspace', { workspaceId: workspace.id });

    expect(await git(first, 'rev-parse', 'HEAD')).toBe(before);
    expect(await readFile(join(second, 'file.txt'), 'utf8')).toBe('base');
  }, 20000);

  it('patches enablement through MCP with the same confirmation rules as the UI', async () => {
    /// @case An MCP caller disables a dirty project, confirms, then edits unrelated metadata.
    /// @expect Confirmation is required, enabled stays false and no Git mutation occurs.
    const path = await repository('project');
    const workspace = await call('create_workspace', {
      name: 'MCP',
      worktreePaths: [path],
    });
    const project = workspace.projects[0];
    expect(project.enabled).toBe(true);
    await writeFile(join(path, 'file.txt'), 'local edits');
    const input = { workspaceId: workspace.id, projectId: project.id };
    const refused = await requestTool('update_project', {
      ...input,
      changes: { enabled: false },
    });
    expect(refused.status).toBe(409);
    const confirmation = await refused.json();
    expect(confirmation.disableConfirmation.reasons.join('\n')).toContain('未提交');
    await call('update_project', {
      ...input,
      changes: { enabled: false, confirmDisable: true },
    });
    const edited = await call('update_project', {
      ...input,
      changes: { name: 'Edited metadata' },
    });
    expect(edited.projects[0]).toMatchObject({ enabled: false, name: 'Edited metadata' });
    const invalid = await requestTool('update_project', {
      ...input,
      changes: { enabled: true, confirmDisable: true },
    });
    expect(invalid.status).toBe(400);
    expect(await git(path, 'diff', '--cached', '--name-only')).toBe('');
    expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('local edits');
  }, 20000);

  it('rejects invalid arguments, cycles and manual submodule disconnection', async () => {
    /// @case Tool calls attempt invalid patches and edits that violate workspace graph invariants.
    /// @expect Errors reach the caller and leave the saved document unchanged.
    const parent = await repository('parent');
    const source = await repository('source');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');

    const workspace = await call('create_workspace', {
      name: 'MCP',
      worktreePaths: [parent],
    });

    const [root, child] = workspace.projects;
    const preserved = await call('update_project', {
      workspaceId: workspace.id,
      projectId: root.id,
      changes: { manualDependencyIds: [] },
    });

    expect(preserved.connections).toEqual(workspace.connections);

    const saved = preserved;
    const cyclicDependencies = await requestTool('update_project', {
      workspaceId: workspace.id,
      projectId: child.id,
      changes: { manualDependencyIds: [root.id] },
    });

    expect(cyclicDependencies.status).toBe(400);

    const submoduleRemoval = await requestTool('remove_project', {
      workspaceId: workspace.id,
      projectId: child.id,
    });

    expect(submoduleRemoval.status).toBe(409);

    const unknownProjectField = await requestTool('update_project', {
      workspaceId: workspace.id,
      projectId: root.id,
      changes: { checkout: 'main' },
    });

    expect(unknownProjectField.status).toBe(400);

    const emptyChanges = await requestTool('update_project', {
      workspaceId: workspace.id,
      projectId: root.id,
      changes: {},
    });

    expect(emptyChanges.status).toBe(400);

    const missingWorkspace = await requestTool('get_workspace', {
      workspaceId: '../unknown',
    });

    expect(missingWorkspace.status).toBe(404);

    const unchangedWorkspace = await call('get_workspace', { workspaceId: workspace.id });
    expect(unchangedWorkspace).toEqual(saved);
  }, 20000);
});
