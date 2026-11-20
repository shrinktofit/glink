import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceDocument } from '@glink/protocol/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGlinkRequestHandler } from '../src/workspace/workspace-request-handler.ts';

const execute = promisify(execFile);
const prefix = join(tmpdir(), 'glink-baseline-');

describe('Pinned workspace baselines and Git references through the public HTTP API', () => {
  let directory: string;
  let home: string;
  let repository: string;
  let origin: string;
  let server: Server;

  async function git(...args: string[]) {
    const { stdout } = await execute('git', [
      '-C',
      repository,
      '-c',
      'user.name=Glink Test',
      '-c',
      'user.email=test@glink.local',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ], { encoding: 'utf8', windowsHide: true });

    return stdout.trim();
  }

  async function commit(content: string) {
    await writeFile(join(repository, 'file.txt'), content);
    await git('add', 'file.txt');
    await git('commit', '-m', content);
    return git('rev-parse', 'HEAD');
  }

  async function createWorkspace() {
    const response = await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Baseline test', worktreePaths: [repository] }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<WorkspaceDocument>;
  }

  async function patchProject(workspace: WorkspaceDocument, changes: Record<string, unknown>) {
    const response = await fetch(`${origin}/api/tools/update_project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspace.id,
        projectId: workspace.projects[0].id,
        changes,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<WorkspaceDocument>;
  }

  async function compare(workspace: WorkspaceDocument, commit: string, ref: string) {
    const query = new URLSearchParams({ commit, ref });
    const response = await fetch(
      `${origin}/api/workspaces/${workspace.id}/projects/${workspace.projects[0].id}`
      + `/baseline-comparison?${query}`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }

  beforeEach(async () => {
    directory = await mkdtemp(prefix);
    home = join(directory, 'home');
    repository = join(directory, 'repository');
    await mkdir(repository);
    await git('init', '-b', 'main');
    await commit('Base');

    server = createServer(await createGlinkRequestHandler({ glinkHome: home }));
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
      server.close((error) => error ? reject(error) : fulfill());
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

  it('records the actual initial reference and keeps detached baselines commit-only', async () => {
    /// @case A workspace is created first on a branch and then at a detached HEAD.
    /// @expect Store the complete commit and actual ref without guessing another matching branch.
    const sha = await git('rev-parse', 'HEAD');
    const attached = await createWorkspace();
    expect(attached.version).toBe(3);
    expect(attached.projects[0].baseline).toEqual({ commit: sha, ref: 'refs/heads/main' });
    expect(attached.projects[0].binding).toEqual({ kind: 'branch', revision: 'refs/heads/main' });

    await git('checkout', '--detach', sha);
    await fetch(`${origin}/api/workspaces/${attached.id}`, { method: 'DELETE' });
    const detached = await createWorkspace();
    expect(detached.projects[0].baseline).toEqual({ commit: sha });
  });

  it('preserves the pin on metadata edits and applies only explicit snapshots', async () => {
    /// @case The source branch advances after creation and again before a snapshot is saved.
    /// @expect Metadata edits preserve the baseline; updates pin only the submitted commit.
    let workspace = await createWorkspace();
    const original = workspace.projects[0].baseline;
    const next = await commit('Next');

    workspace = await patchProject(workspace, { name: 'Renamed', settled: true });
    expect(workspace.projects[0].baseline).toEqual(original);

    const newest = await commit('Newest');
    workspace = await patchProject(workspace, {
      baseline: { commit: next.slice(0, 8), ref: 'refs/heads/main' },
    });
    expect(workspace.projects[0].baseline).toEqual({ commit: next, ref: 'refs/heads/main' });
    expect(await git('rev-parse', 'HEAD')).toBe(newest);

    const file = join(home, 'workspaces', `${workspace.id}.glink-workspace.yaml`);
    const before = await readFile(file, 'utf8');
    await compare(workspace, next, 'refs/heads/main');
    expect(await readFile(file, 'utf8')).toBe(before);

    workspace = await patchProject(workspace, { baseline: null });
    expect(workspace.projects[0].baseline).toBeUndefined();
  });

  it('compares unchanged, advanced, rewound, diverged and deleted refs', async () => {
    /// @case The selected ref is unchanged, advances, rewinds, diverges or is removed.
    /// @expect Counts describe the baseline relative to the ref; deletion preserves the saved pin.
    const workspace = await createWorkspace();
    const base = await git('rev-parse', 'HEAD');
    const next = await commit('Next');
    await git('branch', 'anchor', base);

    expect(await compare(workspace, base, 'refs/heads/anchor')).toEqual({
      state: 'available',
      commit: base,
      aheadCount: 0,
      behindCount: 0,
    });
    expect(await compare(workspace, base, 'refs/heads/main')).toEqual({
      state: 'available',
      commit: next,
      aheadCount: 0,
      behindCount: 1,
    });
    expect(await compare(workspace, next, 'refs/heads/anchor')).toEqual({
      state: 'available',
      commit: base,
      aheadCount: 1,
      behindCount: 0,
    });

    await git('checkout', '-b', 'side', base);
    const side = await commit('Side');
    expect(await compare(workspace, side, 'refs/heads/main')).toEqual({
      state: 'available',
      commit: next,
      aheadCount: 1,
      behindCount: 1,
    });
    const saved = await patchProject(workspace, {
      baseline: { commit: base, ref: 'refs/heads/anchor' },
    });
    await git('branch', '-D', 'anchor');
    expect(await compare(workspace, base, 'refs/heads/anchor')).toEqual({ state: 'missing' });
    const response = await fetch(`${origin}/api/workspaces/${workspace.id}`);
    expect((await response.json()).projects[0].baseline).toEqual(saved.projects[0].baseline);
  });

  it('supports branch and tag selections while always storing commit object IDs', async () => {
    /// @case A repository has local and remote branches, lightweight, annotated and nested tags.
    /// @expect Choices use canonical refs and peeled commits; associations never checkout Git.
    const workspace = await createWorkspace();
    const sha = await git('rev-parse', 'HEAD');
    await git('update-ref', 'refs/remotes/origin/main', sha);
    await git('tag', 'light');
    await git('tag', '-a', 'release', '-m', 'Release');
    await git('tag', '-a', 'nested', 'release', '-m', 'Nested');
    const blob = await git('hash-object', 'file.txt');
    await git('tag', 'blob', blob);

    const response = await fetch(
      `${origin}/api/workspaces/${workspace.id}/projects/${workspace.projects[0].id}/references`,
    );
    expect(response.status).toBe(200);
    const references = await response.json();
    expect(references.some((entry: { ref: string }) => entry.ref === 'refs/tags/blob')).toBe(false);
    for (const ref of [
      'refs/heads/main',
      'refs/remotes/origin/main',
      'refs/tags/light',
      'refs/tags/release',
      'refs/tags/nested',
    ]) {
      expect(references).toContainEqual(expect.objectContaining({ ref, commit: sha }));
    }

    const saved = await patchProject(workspace, {
      baseline: { commit: sha, ref: 'refs/tags/release' },
      binding: { kind: 'tag', revision: 'refs/tags/release' },
    });
    expect(saved.projects[0].baseline).toEqual({ commit: sha, ref: 'refs/tags/release' });
    expect(saved.projects[0].binding).toEqual({ kind: 'tag', revision: 'refs/tags/release' });
    expect(await git('branch', '--show-current')).toBe('main');
    const status = await fetch(`${origin}/api/workspaces/${workspace.id}/status`);
    expect((await status.json())[0].bindingMismatch).toBe(false);
  });

  it('distinguishes a missing ref from invalid targets and repository read failures', async () => {
    /// @case A ref points to a blob, has a short name, or its repository becomes unavailable.
    /// @expect Return explicit errors instead of pretending a failed inspection means ref deletion.
    const workspace = await createWorkspace();
    const commit = await git('rev-parse', 'HEAD');
    await git('tag', 'blob', await git('hash-object', 'file.txt'));
    const route = `${origin}/api/workspaces/${workspace.id}/projects/${workspace.projects[0].id}`;
    for (const ref of ['main', 'refs/tags/blob']) {
      const query = new URLSearchParams({ commit, ref });
      const response = await fetch(`${route}/baseline-comparison?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    }

    const unavailable = join(directory, 'unavailable');
    await rename(repository, unavailable);
    const query = new URLSearchParams({ commit, ref: 'refs/heads/main' });
    const response = await fetch(`${route}/baseline-comparison?${query}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toHaveProperty('error');
  });
});
