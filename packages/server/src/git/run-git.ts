import { execFile, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { GitIndexLockedError } from './git-index-locked-error.ts';

/** Only reads accept cancellation. Mutations settle even if their HTTP client leaves. */
export function runGit(
  repoPath: string,
  args: readonly string[],
  options: { input?: string; signal?: AbortSignal } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((fulfill, reject) => {
    let executionError: Error | undefined;
    const child = spawn('git', ['-C', repoPath, ...args], {
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > 32 * 1024 * 1024) {
        executionError = new Error('Git stdout exceeded 32 MiB.');
        abort();
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength > 32 * 1024 * 1024) {
        executionError = new Error('Git stderr exceeded 32 MiB.');
        abort();
      } else {
        stderr.push(chunk);
      }
    });
    child.on('error', (error) => {
      executionError = error;
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Git's exit error is authoritative when it closes stdin early (for example index.lock).
      if (error.code !== 'EPIPE' && error.code !== 'EOF') {
        executionError = error;
      }
    });
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      const output = Buffer.concat(stdout).toString('utf8');
      const diagnostic = Buffer.concat(stderr).toString('utf8');
      if (options.signal?.aborted) {
        reject(new Error('Git read canceled.', { cause: options.signal.reason }));
      } else if (executionError) {
        reject(executionError);
      } else if (code !== 0) {
        const lock = /Unable to create '(.+index\.lock)': File exists\./.exec(diagnostic);
        reject(lock
          ? new GitIndexLockedError(lock[1])
          : Object.assign(
            new Error(`Git ${args[0]} failed (${code ?? signal}): ${diagnostic.trim()}`),
            { code, stdout: output, stderr: diagnostic },
          ));
      } else {
        fulfill(output);
      }
    });

    function abort() {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (process.platform === 'win32') {
        execFile('taskkill', [
          '/PID',
          String(child.pid),
          '/T',
          '/F',
        ], {
          windowsHide: true,
        }, (error) => {
          if (error && child.exitCode === null && child.signalCode === null) {
            console.error('Could not cancel Git process tree:', error);
          }
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            console.error('Could not cancel Git process group:', error);
          }
        }
      }
    }

    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(options.input);
  });
}
