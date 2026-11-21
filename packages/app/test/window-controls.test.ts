import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import preloadConfig from '../vite.preload.config.ts';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const electron = require('electron') as string;
const prefix = join(tmpdir(), 'glink-window-controls-');

describe('Native Glink window controls with a sandboxed preload', () => {
  it('opens DevTools, survives reload and rejects unrelated documents', async () => {
    /// @case The real Electron app loads its bundled preload into an isolated test window.
    /// @expect DevTools opens for Glink, reload restores the bridge without exposing Node,
    /// and an unrelated document cannot invoke the native action.
    const directory = await mkdtemp(prefix);
    if (!directory.startsWith(prefix)) {
      throw new Error('Unexpected window test directory.');
    }
    try {
      await mkdir(join(directory, 'profile'));
      await build({
        ...preloadConfig,
        configFile: false,
        root: fileURLToPath(new URL('..', import.meta.url)),
        logLevel: 'silent',
        build: { ...preloadConfig.build, outDir: join(directory, 'runtime') },
      });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const { stdout } = await execute(electron, [
        fileURLToPath(new URL('fixtures/window-controls.ts', import.meta.url)),
        directory,
        join(directory, 'runtime/preload.cjs'),
        '--disable-gpu',
      ], { env, windowsHide: true, timeout: 50000 }).catch((error: Error & { stdout: string }) => {
        throw new Error(`${error.message}\n${error.stdout}`, { cause: error });
      });
      const result = stdout.split(/\r?\n/).find((line) => line.startsWith('GLINK_WINDOW_TEST '));
      expect(result, stdout).toBeDefined();
      expect(JSON.parse(result!.slice('GLINK_WINDOW_TEST '.length))).toEqual({
        nativeWindow: true,
        reloaded: true,
        isolated: true,
        rejectedUntrusted: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
