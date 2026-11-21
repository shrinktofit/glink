import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { lstat as electronStat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { WorkspaceDocument } from '@glink/protocol/workspace';
import type { WorktreeDeletionPlan, WorktreeDeletionResult } from '@glink/protocol/git';
import { createGlinkRequestHandler } from '../../src/workspace/workspace-request-handler.ts';
import { cleanWorktree } from '../../src/git/worktree-removal.ts';

// Test setup and assertions also need physical files: Electron virtualizes .asar paths.
const disk = (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises;
const execute = promisify(execFile);
const [directory, scenario] = process.argv.slice(2);
assert(process.versions.electron, 'This fixture must run in Electron.');
assert(isAbsolute(directory) && directory.startsWith(join(tmpdir(), 'glink-electron-removal-')));

async function git(path: string, ...args: string[]) {
  const { stdout } = await execute('git', [
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
  ], { windowsHide: true });
  return stdout.trim();
}

const main = join(directory, 'main');
const archive = join(directory, 'fixture.asar');
const originalArchive = await disk.readFile(archive);
await disk.mkdir(main);
await git(main, 'init', '-b', 'main');
await disk.copyFile(archive, join(main, 'tracked.asar'));
await disk.writeFile(join(main, '.gitignore'), 'ignored/\nexternal-link\n.worktreeinclude\n');
await git(main, 'add', '.');
await git(main, 'commit', '-m', 'Archive fixture');

const target = scenario === 'linked' ? join(directory, 'linked') : main;
if (scenario === 'linked') {
  await git(main, 'worktree', 'add', '-b', 'feature', target);
}
const external = join(directory, 'external');
await disk.mkdir(external);
await disk.writeFile(join(external, 'keep.txt'), 'outside deletion target');
await disk.symlink(
  external,
  join(target, 'external-link'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
await disk.mkdir(join(target, 'ignored'));
await disk.copyFile(archive, join(target, 'ignored/artifact.asar'));
const asarEnabled = (await electronStat(archive)).isDirectory();
assert(asarEnabled, 'The test must exercise Electron ASAR virtualization.');

let deleted = false;
let keptArchive: boolean | undefined;
let branchKept: boolean | undefined;

if (scenario === 'clean') {
  await disk.copyFile(archive, join(target, 'ignored/kept.asar'));
  await disk.writeFile(join(target, '.worktreeinclude'), 'ignored/kept.asar\n');
  await cleanWorktree(target, true);
  assert.deepEqual(await disk.readFile(join(target, 'ignored/kept.asar')), originalArchive);
  assert.deepEqual(await disk.readFile(join(target, 'tracked.asar')), originalArchive);
  await assert.rejects(disk.lstat(join(target, 'ignored/artifact.asar')), { code: 'ENOENT' });
  await assert.rejects(disk.lstat(join(target, 'external-link')), { code: 'ENOENT' });
  keptArchive = true;
} else {
  const server = createServer(await createGlinkRequestHandler({
    glinkHome: join(directory, 'home'),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  async function request<T>(path: string, input: unknown, status = 200): Promise<T> {
    const response = await fetch(`${origin}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body as T;
  }

  try {
    await request<WorkspaceDocument>('workspaces', { name: 'Fixture', worktreePaths: [target] });
    const plan = await request<WorktreeDeletionPlan>('worktree-deletion/plan', {
      worktreePath: target,
    });
    if (scenario === 'changed') {
      await disk.writeFile(join(target, 'changed-after-plan.txt'), 'new data');
    }
    const result = await request<WorktreeDeletionResult>('worktree-deletion/execute', {
      token: plan.token,
    });
    assert.equal(result.failed, undefined, JSON.stringify(result));
    assert.deepEqual(result.recordErrors, []);
    assert.equal(result.deleted.length, 1);
    await assert.rejects(disk.lstat(target), { code: 'ENOENT' });
    deleted = true;
    if (scenario === 'linked') {
      assert.equal(await git(main, 'rev-parse', 'refs/heads/feature'), plan.worktrees[0].head);
      assert.deepEqual(await disk.readFile(join(main, 'tracked.asar')), originalArchive);
      branchKept = true;
    }
  } finally {
    await new Promise<void>((fulfill, reject) => server.close((error) =>
      error ? reject(error) : fulfill()));
  }
}
assert.equal(await disk.readFile(join(external, 'keep.txt'), 'utf8'), 'outside deletion target');
assert((await electronStat(archive)).isDirectory(), 'ASAR support must remain enabled.');
console.log(JSON.stringify({
  runtime: process.versions.electron,
  deleted,
  keptArchive,
  branchKept,
  asarEnabled,
  externalIntact: true,
}));
