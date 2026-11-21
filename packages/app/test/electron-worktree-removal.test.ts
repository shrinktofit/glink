import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const electron = require('electron') as string;
const distribution = dirname(electron);
const archive = process.platform === 'darwin'
  ? join(distribution, '../Resources/default_app.asar')
  : join(distribution, 'resources/default_app.asar');
const prefix = join(tmpdir(), 'glink-electron-removal-');

describe('Worktree disk operations under Electron with real ASAR archives', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(prefix);
    await copyFile(archive, join(directory, 'fixture.asar'));
  });

  afterEach(async () => {
    if (!directory.startsWith(prefix)) {
      throw new Error('Unexpected Electron test directory.');
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function run(scenario: string) {
    const { stdout } = await execute(electron, [
      fileURLToPath(new URL('fixtures/electron-worktree-removal.ts', import.meta.url)),
      directory,
      scenario,
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      timeout: 50000,
    });
    return JSON.parse(stdout) as {
      runtime: string;
      deleted: boolean;
      branchKept?: boolean;
      keptArchive?: boolean;
      asarEnabled: boolean;
      externalIntact: boolean;
    };
  }

  it.each(['main', 'linked'])('deletes a %s worktree containing ASAR files', async (scenario) => {
    /// @case A temporary worktree contains tracked and ignored ASAR files and an external junction.
    /// @expect Preflight stays valid and deletion succeeds without touching the junction target.
    const result = await run(scenario);
    expect(result.runtime).toBeTruthy();
    expect(result.deleted).toBe(true);
    expect(result.externalIntact).toBe(true);
    expect(result.asarEnabled).toBe(true);
    if (scenario === 'linked') {
      expect(result.branchKept).toBe(true);
    }
  }, 60000);

  it('preserves explicitly kept ASAR files when cleaning', async () => {
    /// @case A worktree include file keeps an ignored ASAR archive
    /// while other artifacts are cleaned.
    /// @expect Retain the physical archive unchanged and leave Electron ASAR support enabled.
    const result = await run('clean');
    expect(result.keptArchive).toBe(true);
    expect(result.externalIntact).toBe(true);
    expect(result.asarEnabled).toBe(true);
  }, 60000);

  it('includes file changes made after preflight in the confirmed deletion', async () => {
    /// @case A file is added to the temporary worktree after deletion preflight completes.
    /// @expect Delete current physical contents while preserving the external junction target.
    const result = await run('changed');
    expect(result.deleted).toBe(true);
    expect(result.externalIntact).toBe(true);
  }, 60000);
});
