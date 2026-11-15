import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { runGit } from './run-git.ts';

const writes = new Map<string, Promise<void>>();

export async function gitIndexPath(repoPath: string, signal?: AbortSignal) {
  const path = (await runGit(repoPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'index',
  ], { signal })).trim();
  return join(await realpath(dirname(path)), basename(path));
}

/** Share one queue across repository/workspace APIs, keyed by the actual index, not the repo. */
export async function withGitIndex<T>(
  repoPath: string, action: (indexPath: string) => Promise<T>,
) {
  const path = await gitIndexPath(repoPath);
  const result = (writes.get(path) ?? Promise.resolve()).then(() => action(path));
  const settled = result.then(() => undefined, () => undefined);
  writes.set(path, settled);
  void settled.then(() => {
    if (writes.get(path) === settled) {
      writes.delete(path);
    }
  });
  return result;
}
