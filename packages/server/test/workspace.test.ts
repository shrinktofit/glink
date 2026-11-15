import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitReference } from '@glink/protocol/git';
import { parse } from 'yaml';
import {
  ProjectBindingKind,
  WorkspaceConnectionKind,
  type GlinkCatalog,
  type WorkspaceCommit,
  type WorkspaceCommitResult,
  type WorkspaceDocument,
  type WorkspaceProjectStatus,
} from '@glink/protocol/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGlinkRequestHandler } from '../src/workspace/workspace-request-handler.ts';

const execute = promisify(execFile);
const temporaryPrefix = join(tmpdir(), 'glink-workspace-');

describe('Workspace HTTP operations in isolated temporary repositories', () => {
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
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return stdout.trim();
  }

  async function repository(name: string) {
    const path = join(directory, name);
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    await writeFile(join(path, 'file.txt'), 'base\n');
    await git(path, 'add', 'file.txt');
    await git(path, 'commit', '-m', 'Base');
    // Workspace commits run through the service, so identity must be repository-local.
    await git(path, 'config', 'user.name', 'Glink Test');
    await git(path, 'config', 'user.email', 'test@glink.local');
    await git(path, 'config', 'commit.gpgsign', 'false');
    return path;
  }

  async function start() {
    server = createServer(await createGlinkRequestHandler({ glinkHome: home }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address.');
    }
    origin = `http://127.0.0.1:${address.port}`;
  }

  async function stop() {
    await new Promise<void>((fulfill, reject) =>
      server.close((error) => (error ? reject(error) : fulfill())),
    );
  }

  async function request<T>(
    route: string,
    method = 'GET',
    input?: unknown,
    status = 200,
  ): Promise<T> {
    const response = await fetch(`${origin}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value as T;
  }

  async function create(
    paths: string[],
    dependencies?: Array<{ fromPath: string; toPath: string }>,
  ) {
    return request<WorkspaceDocument>('workspaces', 'POST', {
      name: 'Connected work',
      worktreePaths: paths,
      dependencies,
    });
  }

  async function stage(workspace: WorkspaceDocument, projectId: string, path = 'file.txt') {
    await request(`workspaces/${workspace.id}/index`, 'POST', { projectId, path, action: 'stage' });
  }

  beforeEach(async () => {
    directory = await mkdtemp(temporaryPrefix);
    home = join(directory, 'home');
    await start();
  });
  afterEach(async () => {
    await stop();
    if (!directory.startsWith(temporaryPrefix)) {
      throw new Error('Unexpected test directory.');
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('persists metadata and rejects cycles without checking out branches', async () => {
    /// @case Two worktrees form a workspace; metadata is edited and the server reopened.
    /// @expect YAML survives reopening, invalid cycles are rejected, and Git state is unchanged.
    const a = await repository('a');
    const b = join(directory, 'linked-worktree');
    await git(a, 'worktree', 'add', '-b', 'secondary', b);
    await git(a, 'branch', 'feature');
    const workspace = await create([a, b], [{ fromPath: a, toPath: b }]);
    const [first, second] = workspace.projects;
    const before = await git(a, 'rev-parse', 'HEAD');
    await request(`workspaces/${workspace.id}/projects/${first.id}`, 'PATCH', {
      ...first,
      name: 'Application',
      settled: true,
      binding: { kind: ProjectBindingKind.branch, revision: 'feature' },
      dependencyIds: [second.id],
    });
    await request(
      `workspaces/${workspace.id}/projects/${second.id}`,
      'PATCH',
      {
        ...second,
        dependencyIds: [first.id],
      },
      400,
    );
    await stop();
    await start();
    const reopened = await request<WorkspaceDocument>(`workspaces/${workspace.id}`);
    expect(reopened.projects[0]).toMatchObject({
      name: 'Application',
      settled: true,
      binding: { kind: 'branch', revision: 'feature' },
      baseCommit: before,
    });
    expect(await git(a, 'branch', '--show-current')).toBe('main');
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(before);
    const catalog = await request<GlinkCatalog>('glink/state');
    expect(catalog.home).toBe(home);
    const yaml = parse(
      await readFile(join(home, 'workspaces', catalog.workspaces[0].fileName), 'utf8'),
    );
    expect(yaml).toEqual(reopened);
    await request(`workspaces/${workspace.id}`, 'DELETE');
    expect((await request<GlinkCatalog>('glink/state')).workspaces).toEqual([]);
    expect(await readFile(join(a, 'file.txt'), 'utf8')).toBe('base\n');
  }, 60000);

  it('locks recursive submodules and enforces parent-first removal', async () => {
    /// @case A parent contains a submodule which contains another initialized submodule.
    /// @expect All three appear once, auto edges cannot disconnect, children cannot be removed
    /// first.
    const leaf = await repository('leaf-source');
    const child = await repository('child-source');
    await git(child, '-c', 'protocol.file.allow=always', 'submodule', 'add', leaf, 'nested');
    await git(child, 'commit', '-am', 'Add nested');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child');
    await git(parent, 'commit', '-am', 'Add child');
    await git(
      parent,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--recursive',
    );
    const workspace = await create([parent, join(parent, 'child')]);
    expect(workspace.projects).toHaveLength(3);
    expect(workspace.connections.map((edge) => edge.kind)).toEqual([
      WorkspaceConnectionKind.submodule,
      WorkspaceConnectionKind.submodule,
    ]);
    const root = workspace.projects[0];
    const childProject = workspace.projects[1];
    await request(
      `workspaces/${workspace.id}/projects/${root.id}`,
      'PATCH',
      { ...root, dependencyIds: [] },
      409,
    );
    await request(
      `workspaces/${workspace.id}/projects/${childProject.id}`,
      'DELETE',
      undefined,
      409,
    );
    await request(`workspaces/${workspace.id}/projects/${root.id}`, 'DELETE');
    const remaining = await request<WorkspaceDocument>(
      `workspaces/${workspace.id}/projects/${childProject.id}`,
      'DELETE',
    );
    expect(remaining.projects).toHaveLength(1);
    expect(await git(join(parent, 'child'), 'rev-parse', 'HEAD')).toBe(childProject.baseCommit);
  }, 60000);

  it('aggregates base..HEAD history and rejects stale staged snapshots', async () => {
    /// @case A project has a base, a newer commit and separately staged/unstaged content.
    /// @expect History uses base..HEAD; diffs use the correct index; unseen staging prevents
    /// commit.
    const path = await repository('project');
    const workspace = await create([path]);
    const project = workspace.projects[0];
    await writeFile(join(path, 'file.txt'), 'committed\n');
    await git(path, 'commit', '-am', 'Focused change');
    const history = await request<{ commits: WorkspaceCommit[] }>(
      `workspaces/${workspace.id}/commits`,
    );
    expect(history.commits.map((commit) => commit.subject)).toEqual(['Focused change']);
    await writeFile(join(path, 'file.txt'), 'staged\n');
    await stage(workspace, project.id);
    await writeFile(join(path, 'file.txt'), 'unstaged\n');
    const statuses = await request<WorkspaceProjectStatus[]>(`workspaces/${workspace.id}/status`);
    expect(statuses[0].staged[0].path).toBe('file.txt');
    expect(statuses[0].unstaged[0].path).toBe('file.txt');
    const query = new URLSearchParams({ projectId: project.id, path: 'file.txt', staged: 'false' });
    expect(await request(`workspaces/${workspace.id}/diff?${query}`)).toEqual({
      original: 'staged\n',
      modified: 'unstaged\n',
    });
    await stage(workspace, project.id);
    await request(
      `workspaces/${workspace.id}/commit`,
      'POST',
      { projectIds: [project.id], message: 'Do not commit', expected: statuses },
      409,
    );
    expect(await git(path, 'log', '-1', '--format=%s')).toBe('Focused change');
  }, 60000);

  it('reports partial failure without retrying committed projects', async () => {
    /// @case A dependency commits successfully, then its parent hook rejects the commit.
    /// @expect The response identifies the successful child and failed parent; no rollback occurs.
    const parent = await repository('parent');
    const child = await repository('child');
    const workspace = await create([parent, child], [{ fromPath: parent, toPath: child }]);
    const hookDirectory = join(parent, '.git', 'hooks');
    await writeFile(join(hookDirectory, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    for (const [index, path] of [parent, child].entries()) {
      await writeFile(join(path, 'file.txt'), 'staged change\n');
      await stage(workspace, workspace.projects[index].id);
    }
    const expected = await request<WorkspaceProjectStatus[]>(`workspaces/${workspace.id}/status`);
    const result = await request<WorkspaceCommitResult>(`workspaces/${workspace.id}/commit`, 'POST', {
      projectIds: workspace.projects.map((project) => project.id),
      message: 'Partial',
      expected,
    });
    expect(result.committed.map((entry) => entry.projectId)).toEqual([workspace.projects[1].id]);
    expect(result.failed?.projectId).toBe(workspace.projects[0].id);
    expect(await git(parent, 'log', '-1', '--format=%s')).toBe('Base');
    expect(await git(child, 'log', '-1', '--format=%s')).toBe('Partial');
  }, 60000);

  it('retains malformed YAML instead of replacing user data', async () => {
    /// @case state.yaml is edited into an invalid document.
    /// @expect Reads report an error and leave the original contents untouched.
    const invalid = 'version: 1\nworkspaces: invalid\n';
    await writeFile(join(home, 'state.yaml'), invalid);
    await request('glink/state', 'GET', undefined, 400);
    expect(await readFile(join(home, 'state.yaml'), 'utf8')).toBe(invalid);
  });

  it('requires unique workspace names for name-based URLs', async () => {
    /// @case A workspace name is used again, including surrounding whitespace.
    /// @expect Creation rejects the duplicate and preserves the original workspace.
    const first = await request<WorkspaceDocument>('workspaces', 'POST', {
      name: '中文 / Feature & UI',
      worktreePaths: [],
    });
    await request('workspaces', 'POST', {
      name: '  中文 / Feature & UI  ',
      worktreePaths: [],
    }, 409);
    const catalog = await request<GlinkCatalog>('glink/state');
    expect(catalog.workspaces.map((workspace) => workspace.id)).toEqual([first.id]);
  });

  it('reports an index lock conflict without deleting the lock or changing the index', async () => {
    /// @case A linked worktree has a pre-existing index.lock and a file is staged via both APIs.
    /// @expect Both return a readable 409 conflict, leave the lock/index intact and allow retry.
    const main = await repository('main');
    const path = join(directory, 'linked');
    await git(main, 'worktree', 'add', '-b', 'linked', path);
    const workspace = await create([path]);
    const project = workspace.projects[0];
    const lockPath = await git(path,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index.lock');
    const indexPath = await git(path,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index');
    const originalIndex = await readFile(indexPath);
    await writeFile(join(path, 'file.txt'), 'stage me\n');
    await writeFile(lockPath, '', { flag: 'wx' });
    const input = { projectId: project.id, path: 'file.txt', action: 'stage' };
    const conflict = await request<{ error: string }>(
      `workspaces/${workspace.id}/index`, 'POST', input, 409,
    );
    expect(conflict.error).toContain('index.lock');
    expect(conflict.error).not.toContain('Command failed:');
    await request('git/index', 'POST', { repoPath: path, ...input }, 409);
    expect(await readFile(lockPath, 'utf8')).toBe('');
    expect(await readFile(indexPath)).toEqual(originalIndex);
    await rm(lockPath);
    await stage(workspace, project.id);
    expect((await request<WorkspaceProjectStatus[]>(`workspaces/${workspace.id}/status`))[0]
      .staged.map((file) => file.path)).toEqual(['file.txt']);
  }, 60000);

  it('offers branch names for base selection while keeping the saved commit pinned', async () => {
    /// @case Local and remote branches point at a base commit, then one branch advances.
    /// @expect Branch choices expose exact SHAs; saving a branch pins its commit across ref moves.
    const path = await repository('project');
    const workspace = await create([path]);
    const project = workspace.projects[0];
    await git(path, 'branch', 'release/base');
    await git(path, 'update-ref', 'refs/remotes/origin/main', project.baseCommit!);
    await git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await writeFile(join(path, 'file.txt'), 'focused change\n');
    await git(path, 'commit', '-am', 'Focused change');
    const branches = await request<GitReference[]>(
      `workspaces/${workspace.id}/projects/${project.id}/branches`,
    );
    expect(branches).toContainEqual(expect.objectContaining({
      name: 'release/base',
      sha: project.baseCommit,
      current: false,
    }));
    expect(branches).toContainEqual(expect.objectContaining({
      name: 'origin/main',
      sha: project.baseCommit,
      current: false,
    }));
    expect(branches.find((branch) => branch.current)?.name).toBe('main');
    expect(branches.some((branch) => branch.name === 'origin/HEAD')).toBe(false);
    await request(`workspaces/${workspace.id}/projects/${project.id}`, 'PATCH', {
      ...project,
      baseCommit: 'release/base',
      dependencyIds: [],
    });
    await git(path, 'update-ref', 'refs/heads/release/base', 'HEAD');
    const reopened = await request<WorkspaceDocument>(`workspaces/${workspace.id}`);
    expect(reopened.projects[0].baseCommit).toBe(project.baseCommit);
    const history = await request<{ commits: WorkspaceCommit[] }>(
      `workspaces/${workspace.id}/commits`,
    );
    expect(history.commits.map((commit) => commit.subject)).toEqual(['Focused change']);
  }, 60000);

  it('normalizes short hashes and rejects invalid commit selections', async () => {
    /// @case Both fields receive short hashes, then invalid or symbolic commit inputs.
    /// @expect Commits normalize to full SHAs; invalid input returns 400 without YAML changes.
    const path = await repository('project');
    const workspace = await create([path]);
    const project = workspace.projects[0];
    const sha = project.baseCommit!;
    const input = {
      ...project,
      baseCommit: sha.slice(0, 8).toUpperCase(),
      binding: { kind: ProjectBindingKind.commit, revision: sha.slice(0, 8).toUpperCase() },
      dependencyIds: [],
    };
    const saved = await request<WorkspaceDocument>(
      `workspaces/${workspace.id}/projects/${project.id}`, 'PATCH', input);
    expect(saved.projects[0].binding.revision).toBe(sha);
    expect(saved.projects[0].baseCommit).toBe(sha);
    const blob = await git(path, 'hash-object', 'file.txt');
    for (const revision of [
      'HEAD',
      'not-a-hash',
      'deadbeef',
      blob,
    ]) {
      await request(`workspaces/${workspace.id}/projects/${project.id}`, 'PATCH', {
        ...input,
        binding: { kind: ProjectBindingKind.commit, revision },
      }, 400);
    }
    const reopened = await request<WorkspaceDocument>(`workspaces/${workspace.id}`);
    expect(reopened.projects[0]).toEqual(saved.projects[0]);
    await git(path, 'update-ref', 'refs/remotes/origin/main', sha);
    const remote = await request<WorkspaceDocument>(
      `workspaces/${workspace.id}/projects/${project.id}`, 'PATCH', {
        ...input,
        binding: { kind: ProjectBindingKind.branch, revision: 'refs/remotes/origin/main' },
      });
    expect(remote.projects[0].binding.revision).toBe('refs/remotes/origin/main');
  }, 60000);

  it('discovers submodules added after workspace creation', async () => {
    /// @case Git gains a submodule after the workspace has already been saved.
    /// @expect Reopening discovers the auto edge and preserves existing project state.
    const parent = await repository('parent');
    const source = await repository('source');
    const workspace = await create([parent]);
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    const reopened = await request<WorkspaceDocument>(`workspaces/${workspace.id}`);
    expect(reopened.projects).toHaveLength(2);
    expect(reopened.projects[0]).toEqual(workspace.projects[0]);
    expect(reopened.connections[0]).toMatchObject({ from: workspace.projects[0].id,
      to: reopened.projects[1].id,
      kind: WorkspaceConnectionKind.submodule });
  }, 60000);

  it('commits child-first and preserves unstaged files', async () => {
    /// @case Two dependent projects have staged files; a third project has only unstaged changes.
    /// @expect Commits follow dependency order, skip no-staged projects and preserve unstaged
    /// files.
    const a = await repository('a');
    const b = await repository('b');
    const c = await repository('c');
    const workspace = await create([a, b, c], [{ fromPath: a, toPath: b }]);
    for (const [index, path] of [a, b, c].entries()) {
      await writeFile(join(path, 'file.txt'), `change ${index}\n`);
      if (index < 2) {
        await stage(workspace, workspace.projects[index].id);
      }
    }
    const expected = await request<WorkspaceProjectStatus[]>(`workspaces/${workspace.id}/status`);
    const result = await request<WorkspaceCommitResult>(
      `workspaces/${workspace.id}/commit`,
      'POST',
      {
        projectIds: workspace.projects.map((project) => project.id),
        message: 'Together',
        expected,
      },
    );
    expect(result.failed).toBeUndefined();
    expect(result.committed.map((entry) => entry.projectId)).toEqual([
      workspace.projects[1].id,
      workspace.projects[0].id,
    ]);
    expect(result.skipped).toEqual([workspace.projects[2].id]);
    expect(await git(c, 'log', '-1', '--format=%s')).toBe('Base');
    expect(await git(c, 'diff')).toContain('+change 2');
  }, 60000);

  it('requires a strict base ancestor independently of the amend selection limit', async () => {
    /// @case Selected projects can be at, before, after or divergent from their bases.
    /// @expect Every project must pass ancestry validation before the separate one-project rule.
    const a = await repository('a');
    const b = await repository('b');
    const workspace = await create([a, b]);
    const [project, other] = workspace.projects;
    const route = `workspaces/${workspace.id}`;
    const statuses = () => request<WorkspaceProjectStatus[]>(`${route}/status`);
    const attempt = async (ids: string[]) => request<{ error: string }>(`${route}/commit`, 'POST', {
      projectIds: ids,
      message: 'Blocked amend',
      amend: true,
      expected: await statuses(),
    }, 409);
    expect((await statuses())[0].amendBlockedReason).toContain('基础提交');
    expect((await attempt([project.id])).error).toContain('基础提交');
    await git(a, 'commit', '--allow-empty', '-m', 'After base');
    const newer = await git(a, 'rev-parse', 'HEAD');
    expect((await statuses())[0].amendBlockedReason).toBeUndefined();
    expect((await attempt([project.id, other.id])).error).toContain('基础提交');
    await git(b, 'commit', '--allow-empty', '-m', 'After base too');
    expect((await attempt([project.id, other.id])).error).toContain('一个');
    await request(`${route}/projects/${project.id}`, 'PATCH', {
      ...project,
      baseCommit: newer,
      dependencyIds: [],
    });
    await git(a, 'reset', '--hard', project.baseCommit!);
    expect((await attempt([project.id])).error).toContain('基础提交');
    await git(a, 'commit', '--allow-empty', '-m', 'Divergent');
    expect((await attempt([project.id])).error).toContain('基础提交');
    expect(await git(a, 'log', '-1', '--format=%s')).toBe('Divergent');
    await request(`${route}/projects/${project.id}`, 'PATCH', {
      ...project,
      baseCommit: '',
      dependencyIds: [],
    });
    expect((await attempt([project.id])).error).toContain('基础提交');
  }, 60000);

  it('amends one project without absorbing unstaged edits or touching its parent', async () => {
    /// @case A dependency is above base; amend changes its message and then its index.
    /// @expect Base and parent stay intact; stale HEAD, index and base are rejected.
    const parent = await repository('parent');
    const child = await repository('child');
    const workspace = await create([parent, child], [{ fromPath: parent, toPath: child }]);
    const project = workspace.projects[1];
    const route = `workspaces/${workspace.id}`;
    await writeFile(join(child, 'file.txt'), 'to amend\n');
    await git(child, 'commit', '-am', 'To amend');
    const statuses = () => request<WorkspaceProjectStatus[]>(`${route}/status`);
    const amend = (expected: WorkspaceProjectStatus[], status = 200) =>
      request<WorkspaceCommitResult>(`${route}/commit`, 'POST', {
        projectIds: [project.id],
        message: 'Amended',
        amend: true,
        expected,
      }, status);
    const first = await statuses();
    const result = await amend(first);
    expect(result.failed).toBeUndefined();
    expect(result.committed.map((entry) => entry.projectId)).toEqual([project.id]);
    expect(await git(child, 'rev-parse', 'HEAD^')).toBe(project.baseCommit);
    await amend(first, 409);
    const beforeIndex = await statuses();
    await writeFile(join(child, 'file.txt'), 'staged\n');
    await stage(workspace, project.id);
    await amend(beforeIndex, 409);
    await writeFile(join(child, 'file.txt'), 'unstaged\n');
    expect((await amend(await statuses())).failed).toBeUndefined();
    expect(await git(child, 'show', 'HEAD:file.txt')).toBe('staged');
    expect(await readFile(join(child, 'file.txt'), 'utf8')).toBe('unstaged\n');
    expect(await git(parent, 'log', '-1', '--format=%s')).toBe('Base');
    const beforeBase = await statuses();
    await request(`${route}/projects/${project.id}`, 'PATCH', {
      ...project,
      baseCommit: await git(child, 'rev-parse', 'HEAD'),
      dependencyIds: [],
    });
    await amend(beforeBase, 409);
  }, 60000);

  it('blocks dirty pointers but permits unrelated commits and unstage in both APIs', async () => {
    /// @case A clean submodule advances, its pointer is staged, then ignored dirt appears.
    /// @expect Stage/commit/amend refuse that pointer; unstage and unrelated parent commits work.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await git(parent, 'commit', '-am', 'Add child');
    const child = join(parent, 'child');
    await git(child, 'commit', '--allow-empty', '-m', 'Child advance');
    const workspace = await create([parent]);
    const project = workspace.projects[0];
    const route = `workspaces/${workspace.id}`;
    await git(parent, 'config', 'submodule.child.ignore', 'all');
    await writeFile(join(child, 'new.txt'), 'dirty\n');
    const statuses = () => request<WorkspaceProjectStatus[]>(`${route}/status`);
    expect((await statuses())[0].unstaged.find((file) => file.path === 'child')?.stageBlockedReason)
      .toContain('子模块');
    for (const endpoint of [`${route}/index`, 'git/index']) {
      await request(endpoint, 'POST', {
        repoPath: parent,
        projectId: project.id,
        path: 'child',
        action: 'stage',
      }, 409);
    }
    await rm(join(child, 'new.txt'));
    await stage(workspace, project.id, 'child');
    await writeFile(join(child, 'file.txt'), 'dirty tracked\n');
    for (const amend of [false, true]) {
      await request('git/commit', 'POST', { repoPath: parent, message: 'Blocked', amend }, 409);
    }
    const result = await request<WorkspaceCommitResult>(`${route}/commit`, 'POST', {
      projectIds: [project.id],
      message: 'Blocked',
      expected: await statuses(),
    });
    expect(result.failed?.error).toContain('子模块');
    await request(`${route}/index`, 'POST', {
      projectId: project.id,
      path: 'child',
      action: 'unstage',
    });
    await writeFile(join(parent, 'file.txt'), 'unrelated\n');
    await stage(workspace, project.id);
    await request('git/commit', 'POST', { repoPath: parent, message: 'Unrelated', amend: false });
    await writeFile(join(child, 'file.txt'), 'base\n');
    await stage(workspace, project.id, 'child');
    await request('git/commit', 'POST', { repoPath: parent, message: 'Pointer', amend: false });
    const pointer = await git(parent, 'rev-parse', 'HEAD:child');
    await writeFile(join(child, 'new.txt'), 'dirty again\n');
    expect((await statuses())[0].amendBlockedReason).toBeUndefined();
    await request('git/commit', 'POST', {
      repoPath: parent,
      message: 'Message-only amend',
      amend: true,
    });
    await writeFile(join(parent, 'file.txt'), 'amended unrelated\n');
    await stage(workspace, project.id);
    const amended = await request<WorkspaceCommitResult>(`${route}/commit`, 'POST', {
      projectIds: [project.id],
      message: 'Amended unrelated file',
      amend: true,
      expected: await statuses(),
    });
    expect(amended.failed).toBeUndefined();
    expect(await git(parent, 'rev-parse', 'HEAD:child')).toBe(pointer);
    expect(await git(parent, 'show', 'HEAD:file.txt')).toBe('amended unrelated');
    expect(await readFile(join(child, 'new.txt'), 'utf8')).toBe('dirty again\n');
  }, 60000);

  it('amends a selected submodule without touching its unselected parent pointer', async () => {
    /// @case Only a submodule above its base is selected for amend.
    /// @expect Its commit is rewritten; parent HEAD and index remain unchanged.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await git(parent, 'commit', '-am', 'Add child');
    const child = join(parent, 'child');
    await git(child, 'config', 'user.name', 'Glink Test');
    await git(child, 'config', 'user.email', 'test@glink.local');
    await git(child, 'config', 'commit.gpgsign', 'false');
    const workspace = await create([parent]);
    const project = workspace.projects[1];
    const parentHead = await git(parent, 'rev-parse', 'HEAD');
    const pointer = await git(parent, 'ls-files', '--stage', 'child');
    await writeFile(join(child, 'file.txt'), 'new child\n');
    await git(child, 'commit', '-am', 'Child change');
    const route = `workspaces/${workspace.id}`;
    const result = await request<WorkspaceCommitResult>(`${route}/commit`, 'POST', {
      projectIds: [project.id],
      message: 'Amended child',
      amend: true,
      expected: await request<WorkspaceProjectStatus[]>(`${route}/status`),
    });
    expect(result.failed).toBeUndefined();
    expect(result.committed.map((entry) => entry.projectId)).toEqual([project.id]);
    expect(await git(parent, 'rev-parse', 'HEAD')).toBe(parentHead);
    expect(await git(parent, 'ls-files', '--stage', 'child')).toBe(pointer);
    expect(await git(child, 'rev-parse', 'HEAD^')).toBe(project.baseCommit);
  }, 60000);

  it.each([false, true])('skips dirty pointers; parent staged files: %s', async (staged) => {
    /// @case Child staged code is committed but other edits remain in its worktree.
    /// @expect Parent pointer stays unchanged; its other staged files commit, or it is skipped.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await git(parent, 'commit', '-am', 'Add child');
    const child = join(parent, 'child');
    await git(child, 'config', 'user.name', 'Glink Test');
    await git(child, 'config', 'user.email', 'test@glink.local');
    await git(child, 'config', 'commit.gpgsign', 'false');
    const workspace = await create([parent]);
    const pointer = await git(parent, 'ls-files', '--stage', 'child');
    await writeFile(join(child, 'file.txt'), 'staged\n');
    await stage(workspace, workspace.projects[1].id);
    await writeFile(join(child, 'file.txt'), 'unstaged\n');
    if (staged) {
      await writeFile(join(parent, 'file.txt'), 'parent staged\n');
      await stage(workspace, workspace.projects[0].id);
    }
    const route = `workspaces/${workspace.id}`;
    const result = await request<WorkspaceCommitResult>(`${route}/commit`, 'POST', {
      projectIds: workspace.projects.map((project) => project.id),
      message: 'Child only',
      expected: await request<WorkspaceProjectStatus[]>(`${route}/status`),
    });
    expect(result.failed).toBeUndefined();
    expect(result.committed.map((entry) => entry.projectId)).toEqual([
      workspace.projects[1].id,
      ...(staged ? [workspace.projects[0].id] : []),
    ]);
    expect(result.skipped).toEqual(staged ? [] : [workspace.projects[0].id]);
    expect(await git(parent, 'ls-files', '--stage', 'child')).toBe(pointer);
    expect(await git(child, 'show', 'HEAD:file.txt')).toBe('staged');
    expect(await readFile(join(child, 'file.txt'), 'utf8')).toBe('unstaged\n');
    expect(await git(parent, 'show', 'HEAD:file.txt')).toBe(staged ? 'parent staged' : 'base');
  }, 60000);

  it('propagates a committed submodule revision through selected parents', async () => {
    /// @case A selected submodule has staged code while its parent initially has no staged changes.
    /// @expect The child commits first and the parent commits exactly its updated gitlink.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await git(parent, 'commit', '-am', 'Add child');
    const child = join(parent, 'child');
    await git(child, 'config', 'user.name', 'Glink Test');
    await git(child, 'config', 'user.email', 'test@glink.local');
    await git(child, 'config', 'commit.gpgsign', 'false');
    const workspace = await create([parent]);
    await writeFile(join(child, 'file.txt'), 'child change\n');
    await stage(workspace, workspace.projects[1].id);
    const expected = await request<WorkspaceProjectStatus[]>(`workspaces/${workspace.id}/status`);
    const result = await request<WorkspaceCommitResult>(
      `workspaces/${workspace.id}/commit`,
      'POST',
      {
        projectIds: workspace.projects.map((project) => project.id),
        message: 'Submodule together',
        expected,
      },
    );
    expect(result.failed).toBeUndefined();
    expect(result.committed.map((entry) => entry.projectId)).toEqual([
      workspace.projects[1].id,
      workspace.projects[0].id,
    ]);
    expect(await git(parent, 'rev-parse', 'HEAD:child')).toBe(
      await git(child, 'rev-parse', 'HEAD'),
    );
    expect(await git(parent, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe(
      'child',
    );
  }, 60000);
});
