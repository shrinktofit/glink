import { cleanWorktree } from '../src/git/worktree-removal.ts';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
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

  it('streams ordered preflight states and attributes failures to the active check', async () => {
    /// @case A standalone main is inspected, then gains a linked worktree that prevents deletion.
    /// @expect Complete with a warning, or a topology error without a delete token.
    const target = await repository('target');
    const inspect = async () => {
      const response = await fetch(`${origin}/api/worktree-deletion/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreePath: target }),
      });
      expect(response.headers.get('content-type')).toContain('application/x-ndjson');
      return (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as {
        progress?: { id: string; state: string; detail?: string };
        plan?: { token: string };
        error?: string;
      });
    };
    let events = await inspect();
    expect(events.filter((event) => event.progress).map((event) => event.progress!.state))
      .toEqual([
        'in-progress',
        'ok',
        'in-progress',
        'ok',
        'in-progress',
        'ok',
        'in-progress',
        'warn',
      ]);
    expect(events.at(-1)?.plan?.token).toBeTruthy();
    await git(target, 'worktree', 'add', '-b', 'linked', join(directory, 'linked'));
    events = await inspect();
    expect(events.at(-2)?.progress).toMatchObject({ id: 'topology', state: 'error' });
    expect(events.at(-1)?.error).toContain('其他 worktree');
    expect(events.some((event) => event.plan)).toBe(false);
    expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('base\n');
  }, 20000);

  it('cleans include paths without following junctions or resetting tracked edits', async () => {
    /// @case Includes keep a deep literal file and a directory; another junction points outside.
    /// @expect Kept paths and external data survive; other ignored/untracked files are removed.
    const target = await repository('target');
    const external = join(directory, 'outside');
    await mkdir(external);
    await writeFile(join(external, 'keep'), 'external');
    await mkdir(join(target, 'cache', 'deep'), { recursive: true });
    await mkdir(join(target, 'kept'));
    await writeFile(join(target, 'cache/deep/[x].txt'), 'literal');
    await writeFile(join(target, 'cache/deep/remove.txt'), 'remove');
    await writeFile(join(target, 'kept/keep'), 'directory');
    await writeFile(join(target, '.gitignore'), 'ignored\n');
    await writeFile(join(target, 'ignored'), 'remove');
    await writeFile(join(target, 'file.txt'), 'tracked edits');
    await writeFile(join(target, '.worktreeinclude'), 'cache/deep/[x].txt\nkept\n');
    await symlink(external, join(target, 'junction'), 'junction');
    await cleanWorktree(target, true);
    expect(await readFile(join(target, 'cache/deep/[x].txt'), 'utf8')).toBe('literal');
    expect(await readFile(join(target, 'kept/keep'), 'utf8')).toBe('directory');
    expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('tracked edits');
    expect(await readFile(join(external, 'keep'), 'utf8')).toBe('external');
    await expect(lstat(join(target, 'junction'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(target, 'ignored'))).rejects.toMatchObject({ code: 'ENOENT' });
    await cleanWorktree(target, false);
    await expect(lstat(join(target, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20000);

  it('rejects locked and aliased roots before touching contents', async () => {
    /// @case A linked worktree is locked and an alias junction names a real repository.
    /// @expect Neither path authorizes cleanup, including via an alias ancestor.
    const main = await repository('main');
    const linked = join(directory, 'linked');
    await git(main, 'worktree', 'add', '-b', 'feature', linked);
    await git(main, 'worktree', 'lock', '--reason', 'keep', linked);
    await request('worktree-deletion/plan', 'POST', { worktreePath: linked }, 409);
    await symlink(main, join(directory, 'alias'), 'junction');
    await request('worktree-deletion/plan', 'POST', {
      worktreePath: join(directory, 'alias'),
    }, 409);
    expect(await readFile(join(main, 'file.txt'), 'utf8')).toBe('base\n');
  }, 20000);

  it('protects submodule metadata used by outside linked worktrees', async () => {
    /// @case A submodule has a linked worktree outside its parent deletion scope.
    /// @expect Parent deletion is rejected before parent or child cleanup starts.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    const outside = join(directory, 'outside');
    await git(join(parent, 'child'), 'worktree', 'add', '-b', 'outside', outside);
    await writeFile(join(parent, 'keep'), 'keep');
    await request('worktree-deletion/plan', 'POST', { worktreePath: parent }, 409);
    expect(await readFile(join(parent, 'keep'), 'utf8')).toBe('keep');
    expect(await git(join(directory, 'outside'), 'status', '--porcelain')).toBe('');
  }, 20000);

  it('protects deinitialized submodule repositories with outside linked worktrees', async () => {
    /// @case A submodule is deinitialized but its Git data still serves another worktree.
    /// @expect Deleting the parent cannot destroy that shared Git database.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    const outside = join(directory, 'outside');
    await git(join(parent, 'child'), 'worktree', 'add', '-b', 'outside', outside);
    await git(parent, 'submodule', 'deinit', '-f', '--', 'child');
    await request('worktree-deletion/plan', 'POST', { worktreePath: parent }, 409);
    expect(await git(join(directory, 'outside'), 'status', '--porcelain')).toBe('');
  }, 20000);

  it('deletes dirty linked worktrees while preserving branches and link targets', async () => {
    /// @case A linked worktree is in two workspaces and contains a junction to external data.
    /// @expect Planning is read-only; deletion preserves branches and external data.
    const main = await repository('main');
    const linked = join(directory, 'linked');
    await git(main, 'worktree', 'add', '-b', 'feature', linked);
    const workspace = await create([linked]);
    await request('workspaces', 'POST', { name: 'Second', worktreePaths: [linked] });
    const external = join(directory, 'external');
    await mkdir(external);
    await writeFile(join(external, 'keep.txt'), 'keep');
    await symlink(external, join(linked, 'cache'), 'junction');
    await writeFile(join(linked, 'file.txt'), 'dirty');
    const plan = await request<{ token: string; references: unknown[] }>(
      'worktree-deletion/plan', 'POST', { worktreePath: linked },
    );
    expect(plan.references).toHaveLength(2);
    expect(await readFile(join(linked, 'file.txt'), 'utf8')).toBe('dirty');
    const result = await request<{ deleted: string[]; failed?: unknown }>(
      'worktree-deletion/execute', 'POST', { token: plan.token },
    );
    expect(result.failed).toBeUndefined();
    expect(result.deleted).toHaveLength(1);
    await expect(lstat(linked)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await git(main, 'branch', '--list', 'feature')).toContain('feature');
    expect(await git(main, 'worktree', 'list', '--porcelain'))
      .not.toContain(linked.replaceAll('\\', '/'));
    expect((await request<WorkspaceDocument>(`workspaces/${workspace.id}`)).projects).toEqual([]);
  }, 20000);

  it('rejects dependencies, main worktree siblings, and nested repositories', async () => {
    /// @case Referenced projects, mains with siblings, and nested repositories are targeted.
    /// @expect Every rejection precedes cleanup; dirty contents stay intact.
    const main = await repository('main');
    const child = await repository('child');
    await create([main, child], [{ fromPath: main, toPath: child }]);
    await writeFile(join(child, 'untracked'), 'keep');
    await request('worktree-deletion/plan', 'POST', { worktreePath: child }, 409);
    const linked = join(directory, 'linked');
    await git(main, 'worktree', 'add', '-b', 'feature', linked);
    await request('worktree-deletion/plan', 'POST', { worktreePath: main }, 409);
    await repository('child/nested');
    await request('worktree-deletion/plan', 'POST', { worktreePath: child }, 409);
    expect(await readFile(join(child, 'untracked'), 'utf8')).toBe('keep');
  }, 20000);

  it('invalidates a confirmed plan when files or workspace dependencies change', async () => {
    /// @case A user reviews a deletion plan, then files or another workspace changes.
    /// @expect An old confirmation cannot authorize the new deletion scope.
    const target = await repository('target');
    let plan = await request<{ token: string }>('worktree-deletion/plan', 'POST', {
      worktreePath: target,
    });
    await writeFile(join(target, 'new.txt'), 'keep');
    await request('worktree-deletion/execute', 'POST', { token: plan.token }, 409);
    plan = await request('worktree-deletion/plan', 'POST', { worktreePath: target });
    const other = await repository('other');
    await create([other, target], [{ fromPath: other, toPath: target }]);
    await request('worktree-deletion/execute', 'POST', { token: plan.token }, 409);
    expect(await readFile(join(target, 'new.txt'), 'utf8')).toBe('keep');
  }, 20000);

  it('deletes an entire submodule closure and cleans workspace records', async () => {
    /// @case The only main worktree contains a recursive initialized submodule.
    /// @expect Both are in the plan and removed together, without deleting the source repository.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await git(parent, 'commit', '-am', 'Submodule');
    const workspace = await create([parent]);
    const plan = await request<{ token: string; worktrees: unknown[] }>(
      'worktree-deletion/plan', 'POST', { worktreePath: parent },
    );
    expect(plan.worktrees).toHaveLength(2);
    const result = await request<{ deleted: string[]; failed?: unknown }>(
      'worktree-deletion/execute', 'POST', { token: plan.token },
    );
    expect(result.failed).toBeUndefined();
    expect(result.deleted).toHaveLength(2);
    expect((await request<WorkspaceDocument>(`workspaces/${workspace.id}`)).projects).toEqual([]);
    expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('base\n');
  }, 20000);

  async function slowCleanFilter(path: string) {
    const marker = join(directory, 'filter-started');
    const release = join(directory, 'filter-release');
    const script = join(directory, 'slow-filter.cjs');
    await writeFile(script, `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      while (!fs.existsSync(${JSON.stringify(release)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      process.stdin.pipe(process.stdout);
    `);
    await writeFile(join(path, '.gitattributes'), 'file.txt filter=glink-test\n');
    await git(path, 'add', '.gitattributes');
    await git(path, 'commit', '-m', 'Add filter configuration');
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
    await git(path, 'config', 'filter.glink-test.clean', command);
    await writeFile(join(path, 'file.txt'), 'edit\n');
    return { marker, release };
  }

  it('serializes the same index across APIs without blocking linked worktrees', async () => {
    /// @case A slow stage overlaps writes through both APIs and in a linked worktree.
    /// @expect Same-index writes wait; the linked index completes while the first stage is blocked.
    const first = await repository('first');
    const linked = join(directory, 'linked');
    await git(first, 'worktree', 'add', '-b', 'linked', linked);
    const workspace = await create([first, linked]);
    const firstId = workspace.projects[0].id;
    const linkedId = workspace.projects[1].id;
    await writeFile(join(linked, 'file.txt'), 'linked changes\n');
    await writeFile(join(first, 'other.txt'), 'other changes\n');
    const { marker, release } = await slowCleanFilter(first);
    const pending = request<WorkspaceProjectStatus>(`workspaces/${workspace.id}/index`, 'POST', {
      projectId: firstId,
      path: 'file.txt',
      action: 'stage',
    });
    let queued: Promise<unknown> | undefined;
    let settled = false;
    try {
      await expect.poll(async () => readFile(marker, 'utf8').catch(() => '')).not.toBe('');
      queued = request('git/index', 'POST', {
        repoPath: first,
        path: 'other.txt',
        action: 'stage',
      }).finally(() => {
        settled = true;
      });
      const independent = await request<WorkspaceProjectStatus>(
        `workspaces/${workspace.id}/index`, 'POST', {
          projectId: linkedId,
          path: 'file.txt',
          action: 'stage',
        },
      );
      expect(independent.staged.map((file) => file.path)).toContain('file.txt');
      expect(settled).toBe(false);
    } finally {
      await writeFile(release, 'release');
      await Promise.all([pending, queued]);
    }
    const state = await request<WorkspaceProjectStatus[]>(`workspaces/${workspace.id}/status`);
    expect(state[0].staged.map((file) => file.path)).toEqual(['file.txt', 'other.txt']);
  }, 20000);

  it('terminates Git and its clean-filter descendant when a diff read is canceled', async () => {
    /// @case A diff read is blocked inside a Git clean filter, then the HTTP reader disconnects.
    /// @expect Cancellation terminates the owned process tree, including its clean filter.
    const path = await repository('target');
    const { marker, release } = await slowCleanFilter(path);
    const controller = new AbortController();
    const query = new URLSearchParams({ repoPath: path, path: 'file.txt', staged: 'false' });
    const pending = fetch(`${origin}/api/git/diff?${query}`, { signal: controller.signal })
      .catch((error: unknown) => error);
    try {
      await expect.poll(async () => readFile(marker, 'utf8').catch(() => '')).not.toBe('');
      const pid = Number(await readFile(marker, 'utf8'));
      controller.abort();
      await pending;
      await expect.poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
          return false;
        }
      }).toBe(false);
    } finally {
      controller.abort();
      await writeFile(release, 'release');
      await pending;
    }
  }, 20000);

  it.each(['workspace', 'repository'])(
    'uses scoped validation and one changes scan for %s staging', async (mode) => {
      /// @case A normal tracked file is staged through the public API with Git tracing enabled.
      /// @expect Validate its path, read changes once, and avoid HEAD metadata queries.
      const path = await repository('target');
      const workspace = await create([path]);
      const projectId = workspace.projects[0].id;
      await writeFile(join(path, 'file.txt'), 'changed\n');
      const trace = join(directory, 'git-trace.json');
      const previous = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = trace.replaceAll('\\', '/');
      try {
        const route = mode === 'workspace' ? `workspaces/${workspace.id}/index` : 'git/index';
        const state = await request<WorkspaceProjectStatus>(route, 'POST', {
          projectId,
          repoPath: path,
          path: 'file.txt',
          action: 'stage',
        });
        expect(state.staged.map((file) => file.path)).toEqual(['file.txt']);
        expect(state.head).toBe(workspace.projects[0].baseCommit);
        expect(state.indexFingerprint).toMatch(/^[a-f0-9]{64}$/);
        const commands = (await readFile(trace, 'utf8')).trim().split('\n')
          .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
          .filter((event) => event.event === 'start').map((event) => event.argv!);
        const statuses = commands.filter((args) => args.includes('status'));
        expect(statuses.filter((args) => !args.includes('file.txt'))).toHaveLength(1);
        expect(statuses.filter((args) => args.includes('file.txt'))).toHaveLength(1);
        expect(commands.some((args) => [
          'log',
          'branch',
          'rev-list',
          'ls-files',
          'diff',
        ]
          .some((command) => args.includes(command)))).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.GIT_TRACE2_EVENT;
        } else {
          process.env.GIT_TRACE2_EVENT = previous;
        }
      }
    }, 60000,
  );

  it('returns fresh index state and supports scoped status reads', async () => {
    /// @case One project stages/unstages while another worktree is unavailable.
    /// @expect Each mutation returns authoritative target state without discovering other projects.
    const path = await repository('target');
    const other = await repository('other');
    const workspace = await create([path, other]);
    const projectId = workspace.projects[0].id;
    const route = `workspaces/${workspace.id}`;
    await rename(other, `${other}-moved`);
    await writeFile(join(path, 'file.txt'), 'changed\n');
    const staged = await request<WorkspaceProjectStatus>(`${route}/index`, 'POST', {
      projectId,
      path: 'file.txt',
      action: 'stage',
    });
    expect(staged.projectId).toBe(projectId);
    expect(staged.staged.map((file) => file.path)).toEqual(['file.txt']);
    expect(staged.unstaged).toEqual([]);
    expect(staged.indexFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const unstaged = await request<WorkspaceProjectStatus>(`${route}/index-all`, 'POST', {
      projectId,
      action: 'unstage',
    });
    expect(unstaged.staged).toEqual([]);
    expect(unstaged.unstaged.map((file) => file.path)).toEqual(['file.txt']);
    const query = new URLSearchParams({ projectId });
    const states = await request<WorkspaceProjectStatus[]>(`${route}/status?${query}`);
    expect(states.map((state) => state.projectId)).toEqual([projectId]);
    expect(states[0].error).toBeUndefined();
    query.set('projectId', 'missing');
    await request(`${route}/status?${query}`, 'GET', undefined, 404);
  }, 60000);

  it('reports submodule membership after staging and unstaging registration', async () => {
    /// @case A new clean submodule is registered, unstaged, then staged again.
    /// @expect Return current index membership for precise topology invalidation.
    const child = await repository('child-source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child');
    const workspace = await create([parent]);
    const projectId = workspace.projects[0].id;
    const route = `workspaces/${workspace.id}/index-all`;
    const unstaged = await request<WorkspaceProjectStatus>(route, 'POST', {
      projectId,
      action: 'unstage',
    });
    expect(unstaged.submodulePaths).toEqual([]);
    const staged = await request<WorkspaceProjectStatus>(route, 'POST', {
      projectId,
      action: 'stage',
    });
    expect(staged.submodulePaths).toEqual(['child']);
  }, 60000);

  it.each(['workspace', 'repository'])('scopes %s actions by directory', async (mode) => {
    /// @case A linked worktree has nested changes, a similar sibling and a cross-directory rename.
    /// @expect Preserve other paths, the other worktree and both sides of a rename.
    const main = await repository('main');
    const path = join(directory, 'linked');
    await git(main, 'worktree', 'add', '-b', 'linked', path);
    const workspace = await create([path]);
    const projectId = workspace.projects[0].id;
    const route = mode === 'workspace' ? `workspaces/${workspace.id}/index-all` : 'git/index-all';
    const input = { projectId, repoPath: path };
    await mkdir(join(path, 'src', 'deep'), { recursive: true });
    await mkdir(join(path, 'src-other'));
    await mkdir(join(path, 'target'));
    await writeFile(join(path, 'src', 'deep', 'new [文件].txt'), 'nested\n');
    await writeFile(join(path, 'src', 'plain.txt'), 'plain\n');
    await writeFile(join(path, 'src-other', 'outside.txt'), 'sibling\n');
    await writeFile(join(path, 'file.txt'), 'outside\n');

    await request(route, 'POST', { ...input, directory: 'src', action: 'stage' });
    expect(await git(path, 'diff', '--cached', '--name-only', '-z')).toBe(
      'src/deep/new [文件].txt\0src/plain.txt\0',
    );
    await request(route, 'POST', { ...input, directory: 'src/deep', action: 'unstage' });
    expect(await git(path, 'diff', '--cached', '--name-only')).toBe('src/plain.txt');
    expect(await readFile(join(path, 'src', 'deep', 'new [文件].txt'), 'utf8')).toBe('nested\n');

    await git(path, 'mv', 'file.txt', 'target/renamed.txt');
    await request(route, 'POST', { ...input, directory: 'target', action: 'unstage' });
    expect(await git(path, 'diff', '--cached', '--name-only')).toBe('src/plain.txt');
    expect(await readFile(join(path, 'target', 'renamed.txt'), 'utf8')).toBe('outside\n');
    expect(await git(main, 'diff', '--cached', '--name-only')).toBe('');
    expect(await readFile(join(main, 'file.txt'), 'utf8')).toBe('base\n');
    await request(route, 'POST', { ...input, directory: 'gone', action: 'stage' });
    expect(await git(path, 'diff', '--cached', '--name-only')).toBe('src/plain.txt');
    await request(route, 'POST', { ...input, directory: '', action: 'stage' }, 400);
    await request(route, 'POST', { ...input, directory: 42, action: 'stage' }, 400);
  }, 60000);

  it.each(['workspace', 'repository'])('skips dirty pointers in a %s directory', async (mode) => {
    /// @case A directory contains a dirty child worktree and a normal edit; a sibling also changes.
    /// @expect Only the normal edit is staged, without touching the dirty pointer or child index.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'src/child');
    await git(parent, 'commit', '-am', 'Add child');
    const workspace = await create([parent]);
    const route = mode === 'workspace' ? `workspaces/${workspace.id}/index-all` : 'git/index-all';
    const child = join(parent, 'src', 'child');
    const pointer = await git(parent, 'rev-parse', 'HEAD:src/child');
    await git(child, 'commit', '--allow-empty', '-m', 'Advance');
    await writeFile(join(child, 'file.txt'), 'dirty child\n');
    await writeFile(join(parent, 'src', 'ordinary.txt'), 'parent edit\n');
    await writeFile(join(parent, 'file.txt'), 'outside edit\n');

    await request(route, 'POST', {
      projectId: workspace.projects[0].id,
      repoPath: parent,
      directory: 'src',
      action: 'stage',
    });
    expect(await git(parent, 'diff', '--cached', '--name-only')).toBe('src/ordinary.txt');
    expect(await git(parent, 'rev-parse', ':src/child')).toBe(pointer);
    expect(await git(child, 'diff', '--cached', '--name-only')).toBe('');
    expect(await readFile(join(child, 'file.txt'), 'utf8')).toBe('dirty child\n');
  }, 60000);

  it('stages and unstages all changes only in the selected linked worktree', async () => {
    /// @case One project has a rename, deletion and literal untracked path; another also changes.
    /// @expect Batch index actions affect only the selected worktree and never its working files.
    const main = await repository('main');
    await writeFile(join(main, 'deleted.txt'), 'delete me\n');
    await git(main, 'add', '.');
    await git(main, 'commit', '-m', 'Tracked deletion fixture');
    const path = join(directory, 'linked');
    await git(main, 'worktree', 'add', '-b', 'linked', path);
    const workspace = await create([main, path]);
    const project = workspace.projects[1];
    const route = `workspaces/${workspace.id}/index-all`;
    await git(path, 'mv', 'file.txt', 'renamed.txt');
    await writeFile(join(path, 'renamed.txt'), 'base\nnew line\n');
    await writeFile(join(path, 'new [文件].txt'), 'new\n');
    await rm(join(path, 'deleted.txt'));
    await writeFile(join(main, 'file.txt'), 'other worktree\n');
    const head = await git(path, 'rev-parse', 'HEAD');
    await request(route, 'POST', { projectId: project.id, action: 'stage' });
    expect(await git(path, 'show', ':renamed.txt')).toBe('base\nnew line');
    expect(await git(path, 'show', ':new [文件].txt')).toBe('new');
    expect(await git(path, 'ls-files', 'file.txt', 'deleted.txt')).toBe('');
    expect(await git(main, 'diff', '--cached', '--name-only')).toBe('');
    await request(route, 'POST', { projectId: project.id, action: 'unstage' });
    expect(await git(path, 'diff', '--cached', '--name-only')).toBe('');
    expect(await readFile(join(path, 'renamed.txt'), 'utf8')).toBe('base\nnew line\n');
    expect(await readFile(join(path, 'new [文件].txt'), 'utf8')).toBe('new\n');
    expect(await readFile(join(main, 'file.txt'), 'utf8')).toBe('other worktree\n');
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(head);
    await request(route, 'POST', { projectId: project.id, action: 'unstage' });
    await request(route, 'POST', { projectId: project.id, action: 'invalid' }, 400);
  }, 60000);

  it('stages files and clean pointers while leaving dirty submodules untouched', async () => {
    /// @case A parent has normal edits plus clean and dirty submodules with advanced HEADs.
    /// @expect Stage-all skips dirty pointers; unstage-all also works after pointers become dirty.
    const source = await repository('source');
    const parent = await repository('parent');
    for (const name of ['clean', 'dirty']) {
      await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, name);
    }
    await git(parent, 'commit', '-am', 'Add children');
    const workspace = await create([parent]);
    const project = workspace.projects[0];
    const route = `workspaces/${workspace.id}/index-all`;
    const oldPointer = await git(parent, 'rev-parse', 'HEAD:dirty');
    for (const name of ['clean', 'dirty']) {
      await git(join(parent, name), 'commit', '--allow-empty', '-m', 'Advance');
    }
    await writeFile(join(parent, 'dirty', 'file.txt'), 'dirty child\n');
    await writeFile(join(parent, 'file.txt'), 'ordinary edit\n');
    await request(route, 'POST', { projectId: project.id, action: 'stage' });
    expect(await git(parent, 'diff', '--cached', '--name-only')).toBe('clean\nfile.txt');
    expect(await git(parent, 'rev-parse', ':dirty')).toBe(oldPointer);
    expect(await git(parent, 'rev-parse', ':clean')).toBe(
      await git(join(parent, 'clean'), 'rev-parse', 'HEAD'),
    );
    await request(route, 'POST', { projectId: project.id, action: 'stage' });
    await writeFile(join(parent, 'clean', 'untracked.txt'), 'now dirty\n');
    await request(route, 'POST', { projectId: project.id, action: 'unstage' });
    expect(await git(parent, 'diff', '--cached', '--name-only')).toBe('');
    expect(await readFile(join(parent, 'file.txt'), 'utf8')).toBe('ordinary edit\n');
    expect(await readFile(join(parent, 'dirty', 'file.txt'), 'utf8')).toBe('dirty child\n');
  }, 60000);

  it('keeps a new dirty submodule unstaged after unstaging its registration', async () => {
    /// @case A newly added submodule is unstaged, then edited before staging all parent changes.
    /// @expect Its now-untracked pointer stays unstaged while ordinary parent files are staged.
    const source = await repository('source');
    const parent = await repository('parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    const workspace = await create([parent]);
    const project = workspace.projects[0];
    const route = `workspaces/${workspace.id}/index-all`;
    await request(route, 'POST', { projectId: project.id, action: 'unstage' });
    await writeFile(join(parent, 'child', 'file.txt'), 'dirty child\n');
    await writeFile(join(parent, 'file.txt'), 'ordinary edit\n');
    await request(route, 'POST', { projectId: project.id, action: 'stage' });
    expect(await git(parent, 'ls-files', '--stage', 'child')).toBe('');
    expect(await git(parent, 'show', ':file.txt')).toBe('ordinary edit');
    const statuses = await request<WorkspaceProjectStatus[]>(`workspaces/${workspace.id}/status`);
    expect(statuses[0].unstaged.find((file) => file.path.replace(/\/$/, '') === 'child')
      ?.stageBlockedReason).toContain('子模块');
    await writeFile(join(parent, 'child', 'file.txt'), 'base\n');
    await request(route, 'POST', { projectId: project.id, action: 'stage' });
    expect(await git(parent, 'rev-parse', ':child')).toBe(
      await git(join(parent, 'child'), 'rev-parse', 'HEAD'),
    );
  }, 60000);

  it('handles large unborn indexes and lock conflicts without losing work', async () => {
    /// @case An unborn project exceeds the Windows command-line limit and has an index lock.
    /// @expect Batch commands handle every path, keep working files and report 409 on lock.
    const path = join(directory, 'unborn');
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    const files = Array.from({ length: 400 }, (_, index) => `${index}-${'x'.repeat(90)}.txt`);
    await Promise.all(files.map((file) => writeFile(join(path, file), 'new\n')));
    const workspace = await create([path]);
    const project = workspace.projects[0];
    const route = `workspaces/${workspace.id}/index-all`;
    const lock = join(path, '.git', 'index.lock');
    await writeFile(lock, 'test lock');
    await request(route, 'POST', { projectId: project.id, action: 'stage' }, 409);
    expect(await readFile(lock, 'utf8')).toBe('test lock');
    await rm(lock);
    await request(route, 'POST', { projectId: project.id, action: 'stage' });
    expect((await git(path, 'ls-files')).split('\n')).toHaveLength(files.length);
    await request(route, 'POST', { projectId: project.id, action: 'unstage' });
    expect(await git(path, 'ls-files')).toBe('');
    expect(await Promise.all(files.map((file) => readFile(join(path, file), 'utf8'))))
      .toEqual(files.map(() => 'new\n'));
    await request(route, 'POST', { projectId: project.id, action: 'unstage' });
  }, 60000);

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

  it('counts commits ahead of each project base', async () => {
    /// @case HEAD moves after, before and away from base; base can also be absent.
    /// @expect Count HEAD minus base, including divergence, without enabling unsafe amend.
    const path = await repository('project');
    const workspace = await create([path]);
    const project = workspace.projects[0];
    const route = `workspaces/${workspace.id}`;
    const status = async () => (await request<WorkspaceProjectStatus[]>(`${route}/status`))[0];
    expect((await status()).aheadCount).toBe(0);
    await git(path, 'commit', '--allow-empty', '-m', 'First');
    expect((await status()).aheadCount).toBe(1);
    await git(path, 'commit', '--allow-empty', '-m', 'Second');
    const ahead = await status();
    expect(ahead.aheadCount).toBe(2);
    expect(ahead.amendBlockedReason).toBeUndefined();
    await request(`${route}/projects/${project.id}`, 'PATCH', {
      ...project,
      baseCommit: ahead.head,
      dependencyIds: [],
    });
    expect((await status()).aheadCount).toBe(0);
    await git(path, 'checkout', '--detach', project.baseCommit!);
    expect((await status()).aheadCount).toBe(0);
    await git(path, 'commit', '--allow-empty', '-m', 'Divergent');
    const divergent = await status();
    expect(divergent.aheadCount).toBe(1);
    expect(divergent.amendBlockedReason).toContain('基础提交');
    await request(`${route}/projects/${project.id}`, 'PATCH', {
      ...project,
      baseCommit: '',
      dependencyIds: [],
    });
    expect((await status()).aheadCount).toBeUndefined();
    const unborn = join(directory, 'unborn');
    await mkdir(unborn);
    await git(unborn, 'init', '-b', 'main');
    const empty = await request<WorkspaceDocument>('workspaces', 'POST', {
      name: 'Unborn',
      worktreePaths: [unborn],
    });
    const [unbornStatus] = await request<WorkspaceProjectStatus[]>(`workspaces/${empty.id}/status`);
    expect(unbornStatus.aheadCount).toBeUndefined();
    expect(unbornStatus.error).toBeUndefined();
  }, 60000);

  it('filters project history before applying the workspace commit limit', async () => {
    /// @case A busy project fills 500 rows; another selected project has an older focused commit.
    /// @expect Return scoped history without errors from unselected projects.
    const busy = await repository('busy');
    const focused = await repository('focused');
    const workspace = await create([busy, focused]);
    const [busyProject, focusedProject] = workspace.projects;
    const route = `workspaces/${workspace.id}/commits`;
    const base = await git(busy, 'rev-parse', 'HEAD');
    const stream = Array.from({ length: 501 }, (_, index) => {
      const message = `Busy ${index}\n`;
      return `commit refs/heads/main\nmark :${index + 1}\n`
        + 'committer Glink Test <test@glink.local> 2000000000 +0000\n'
        + `data ${message.length}\n${message}from ${index ? `:${index}` : base}\n\n`;
    }).join('');
    const importing = execute('git', [
      '-C',
      busy,
      'fast-import',
      '--quiet',
    ], { windowsHide: true });
    importing.child.stdin!.end(stream);
    await importing;
    await git(focused, 'commit', '--allow-empty', '--date=2020-01-01T00:00:00Z', '-m', 'Focused');
    const all = await request<{ commits: WorkspaceCommit[] }>(route);
    expect(all.commits).toHaveLength(500);
    expect(all.commits.every((commit) => commit.projectId === busyProject.id)).toBe(true);
    const query = new URLSearchParams({ projectId: focusedProject.id });
    const selected = await request<{ commits: WorkspaceCommit[]; errors: unknown[] }>(
      `${route}?${query}`,
    );
    expect(selected.commits).toHaveLength(1);
    expect(selected.commits[0]).toMatchObject({ projectId: focusedProject.id, subject: 'Focused' });
    expect(selected.errors).toEqual([]);
    query.append('projectId', focusedProject.id);
    expect((await request<{ commits: WorkspaceCommit[] }>(`${route}?${query}`)).commits)
      .toHaveLength(1);
    query.set('projectId', busyProject.id);
    expect((await request<{ commits: WorkspaceCommit[] }>(`${route}?${query}`)).commits)
      .toHaveLength(500);
    await rename(busy, `${busy}-moved`);
    query.set('projectId', focusedProject.id);
    expect((await request<{ errors: unknown[] }>(`${route}?${query}`)).errors).toEqual([]);
    query.set('projectId', 'missing-project');
    await request(`${route}?${query}`, 'GET', undefined, 404);
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
