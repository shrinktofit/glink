// Electron treats .asar files as virtual directories with fabricated, unstable stats.
// Worktree scans, cleanup and deletion must use the physical filesystem instead.
import originalFs from 'original-fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { WorktreeDeletionPhase, type WorktreeDeletionTarget } from '@glink/protocol/git';
import { runGit } from './run-git.ts';
import { readSubmodulePaths } from './read-changes.ts';
import { gitIndexPath } from './index-queue.ts';

const {
  lstat,
  readdir,
  readFile,
  realpath,
  unlink,
  rmdir,
} = originalFs.promises;

export class WorktreeRemovalError extends Error {
  readonly status = 409;
}

export function pathIdentity(path: string) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function containsPath(parent: string, child: string) {
  const tail = relative(pathIdentity(parent), pathIdentity(child));
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
}

export interface RemovalTarget extends WorktreeDeletionTarget {
  gitDir: string;
  commonDir: string;
  indexPath: string;
}

async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Inactive submodules retain Git databases too; linked consumers must remain protected. */
async function inspectStoredSubmodules(directory: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const info = await exists(directory);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    return;
  }
  const gitDir = (await runGit(directory, ['rev-parse', '--absolute-git-dir'], { signal })).trim();
  if (pathIdentity(gitDir) === pathIdentity(directory)) {
    const listing = await runGit(directory, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ], { signal });
    if (listing.split('\0\0').filter(Boolean).length > 1) {
      throw new WorktreeRemovalError(`子模块 Git 数据仍被其他 worktree 使用：${directory}`);
    }
    const modules = (await runGit(directory, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'modules',
    ], { signal })).trim();
    await inspectStoredSubmodules(modules, signal);
    return;
  }
  for (const name of (await readdir(directory)).sort()) {
    await inspectStoredSubmodules(join(directory, name), signal);
  }
}

export async function inspectRemoval(
  worktreePath: string, signal?: AbortSignal,
): Promise<RemovalTarget[]> {
  signal?.throwIfAborted();
  if (!isAbsolute(worktreePath) || dirname(resolve(worktreePath)) === resolve(worktreePath)) {
    throw new WorktreeRemovalError('必须选择工作树根目录，不能删除文件系统根目录。');
  }
  const root = resolve(worktreePath);
  if ((await lstat(root)).isSymbolicLink()
    || pathIdentity(await realpath(root)) !== pathIdentity(root)) {
    throw new WorktreeRemovalError('工作树根路径包含符号链接或 junction，不能删除。');
  }
  const targets: RemovalTarget[] = [];
  const deletionRoots = [root];

  async function inspect(path: string, parent?: RemovalTarget) {
    if (pathIdentity(await realpath(path)) !== pathIdentity(path)) {
      throw new WorktreeRemovalError(`子模块路径包含链接：${path}`);
    }
    const marker = await lstat(join(path, '.git'));
    if (marker.isSymbolicLink()) {
      throw new WorktreeRemovalError(`Git 元数据入口是链接，不能删除：${path}`);
    }
    const top = (await runGit(path, ['rev-parse', '--show-toplevel'], { signal })).trim();
    if (pathIdentity(top) !== pathIdentity(path)) {
      throw new WorktreeRemovalError(`不是工作树根目录：${path}`);
    }
    const gitDir = (await runGit(path, ['rev-parse', '--absolute-git-dir'], { signal })).trim();
    const commonDir = (await runGit(path, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ], { signal })).trim();
    if (pathIdentity(await realpath(gitDir)) !== pathIdentity(gitDir)
      || pathIdentity(await realpath(commonDir)) !== pathIdentity(commonDir)) {
      throw new WorktreeRemovalError(`Git 元数据路径包含链接：${path}`);
    }
    const listing = await runGit(path, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ], { signal });
    const entries = listing.split('\0\0').filter(Boolean).map((entry) => entry.split('\0'));
    const main = pathIdentity(gitDir) === pathIdentity(commonDir);
    const own = main
      ? entries[0]
      : entries.find((fields) =>
        fields.includes(`worktree ${path.replaceAll('\\', '/')}`));
    if (!own || own.includes('bare') || own.some((field) => /^locked(?: |$)/.test(field))) {
      throw new WorktreeRemovalError(`工作树不可删除或已锁定：${path}`);
    }
    if (main && entries.length > 1) {
      throw new WorktreeRemovalError(`主工作树还有其他 worktree，不能删除：${path}`);
    }
    const superproject = (await runGit(path, [
      'rev-parse',
      '--show-superproject-working-tree',
    ], { signal })).trim();
    if (parent && (!superproject || pathIdentity(superproject) !== pathIdentity(parent.path))) {
      throw new WorktreeRemovalError(`Git 未确认子模块属于当前工作树：${path}`);
    }
    if (main && !deletionRoots.some((scope) => containsPath(scope, commonDir))) {
      throw new WorktreeRemovalError(`Git 数据位于删除范围外，不能删除：${commonDir}`);
    }
    if (!main) {
      // Git removes this registered worktree's private data, including its submodules.
      deletionRoots.push(gitDir);
    }
    const status = await runGit(path, [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ], { signal });
    const branchOid = status.split('\0').find((line) => line.startsWith('# branch.oid '))
      ?.slice(13);
    const head = branchOid === '(initial)' ? undefined : branchOid;
    const branch = own.find((field) => field.startsWith('branch '))?.slice(7);
    const indexPath = await gitIndexPath(path, signal);
    const target: RemovalTarget = {
      path,
      gitDir,
      commonDir,
      main,
      indexPath,
      head,
      survivingRefs: [],
      branch,
      detached: own.includes('detached'),
      changes: status.split('\0').some((line) =>
        !!line && !line.startsWith('# ')),
    };
    targets.push(target);
    for (const sub of await readSubmodulePaths(path, signal)) {
      const child = resolve(path, sub);
      if (!containsPath(path, child) || child === path) {
        throw new WorktreeRemovalError(`子模块路径越界：${child}`);
      }
      const info = await exists(child);
      if (!info || info.isSymbolicLink() || !await exists(join(child, '.git'))) {
        continue;
      }
      await inspect(child, target);
    }
  }

  await inspect(root);
  for (const target of targets) {
    const databaseDeleted = deletionRoots.some((scope) => containsPath(scope, target.commonDir));
    if (target.head && !databaseDeleted) {
      const containingRefs = await runGit(target.path, [
        'for-each-ref',
        `--contains=${target.head}`,
        '--format=%(refname)',
        // Git documents these namespaces as private to the worktree being deleted.
        '--exclude=refs/bisect/*',
        '--exclude=refs/worktree/*',
        '--exclude=refs/rewritten/*',
      ], { signal });
      target.survivingRefs = containingRefs.trim().split(/\r?\n/).filter(Boolean);
    }
    const modules = (await runGit(target.path, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'modules',
    ], { signal })).trim();
    await inspectStoredSubmodules(modules, signal);
  }
  return targets.reverse();
}

async function removeTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    // Delete Git metadata last, so an earlier file error leaves repository data available.
    const names = (await readdir(path)).sort((a, b) => Number(a === '.git') - Number(b === '.git'));
    for (const entry of names) {
      await removeTree(join(path, entry));
    }
    await rmdir(path);
  } else {
    await unlink(path);
  }
}

/** Includes are literal root-relative paths, one per line; directories keep their subtree. */
export async function cleanWorktree(
  worktreePath: string,
  keepWorktreeIncludes: boolean,
  onPhase?: (phase: WorktreeDeletionPhase) => void,
) {
  onPhase?.(WorktreeDeletionPhase.scan);
  const root = resolve(worktreePath);
  if (!isAbsolute(worktreePath) || dirname(root) === root
    || (await lstat(root)).isSymbolicLink()
    || pathIdentity(await realpath(root)) !== pathIdentity(root)
    || pathIdentity((await runGit(root, ['rev-parse', '--show-toplevel'])).trim())
    !== pathIdentity(root)) {
    throw new WorktreeRemovalError('必须选择不包含链接的工作树根目录。');
  }
  const include = join(root, '.worktreeinclude');
  const kept: string[] = [];
  if (keepWorktreeIncludes && await exists(include)) {
    if ((await lstat(include)).isSymbolicLink()) {
      throw new WorktreeRemovalError('.worktreeinclude 不能是链接。');
    }
    for (const line of (await readFile(include, 'utf8')).split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#')) {
        continue;
      }
      const path = resolve(root, value);
      if (isAbsolute(value) || value.split(/[\\/]/).includes('..')
        || !containsPath(root, path) || path === root || value.split(/[\\/]/).includes('.git')) {
        throw new WorktreeRemovalError(`无效的 .worktreeinclude 路径：${value}`);
      }
      kept.push(path);
    }
    kept.push(include);
  }
  const links: string[] = [];

  async function removeLinks(path: string): Promise<void> {
    if (kept.some((keep) => containsPath(keep, path))) {
      return;
    }
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      if (kept.some((keep) => containsPath(path, keep))) {
        throw new WorktreeRemovalError(`保留路径位于链接下方：${path}`);
      }
      links.push(path);
    } else if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        if (name !== '.git') {
          await removeLinks(join(path, name));
        }
      }
    }
  }

  await removeLinks(root);
  onPhase?.(WorktreeDeletionPhase.unlink);
  for (const path of links) {
    await unlink(path);
  }
  const excludes = kept.flatMap((path) => {
    // Escape gitignore metacharacters: these exclusions describe literal paths.
    const name = relative(root, path).replaceAll('\\', '/').replace(/[\\*?[\]#! ]/g, '\\$&');
    return ['-e', `/${name}`];
  });
  onPhase?.(WorktreeDeletionPhase.clean);
  await runGit(root, [
    'clean',
    '-x',
    '-f',
    '-d',
    '-f',
    ...excludes,
  ]);
}

/** The caller has preflighted the whole closure and holds its index reservations. */
export async function deleteWorktree(
  target: RemovalTarget, onPhase?: (phase: WorktreeDeletionPhase) => void,
) {
  await cleanWorktree(target.path, false, onPhase);
  onPhase?.(WorktreeDeletionPhase.remove);
  if (target.main) {
    await removeTree(target.path);
  } else {
    // Run from the shared Git directory; the target cannot be the command's current directory.
    await runGit(target.commonDir, [
      'worktree',
      'remove',
      '--force',
      '--',
      target.path,
    ]);
  }
  onPhase?.(WorktreeDeletionPhase.verify);
  if (await exists(target.path)) {
    throw new WorktreeRemovalError(`工作树目录仍然存在：${target.path}`);
  }
  if (!target.main) {
    const listing = await runGit(target.commonDir, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]);
    if (listing.split('\0').includes(`worktree ${target.path.replaceAll('\\', '/')}`)) {
      throw new WorktreeRemovalError(`Git 工作树注册仍然存在：${target.path}`);
    }
  }
}
