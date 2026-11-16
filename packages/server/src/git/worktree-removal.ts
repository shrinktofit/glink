import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath, unlink, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import type { WorktreeDeletionTarget } from '@glink/protocol/git';
import { runGit } from './run-git.ts';
import { readSubmodulePaths } from './read-changes.ts';
import { gitIndexPath } from './index-queue.ts';

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
  inventory: string;
  topology: string;
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

/** Never traverse a link, including junctions and dangling links. */
async function inventory(root: string, allowed: Set<string>, signal?: AbortSignal) {
  const hash = createHash('sha256');

  async function visit(path: string) {
    signal?.throwIfAborted();
    const info = await lstat(path);
    hash.update(JSON.stringify([
      relative(root, path),
      info.dev,
      info.ino,
      info.mode,
      info.size,
      info.mtimeMs,
    ]));
    if (info.isSymbolicLink()) {
      hash.update(await readlink(path));
    } else if (info.isDirectory()) {
      if (path !== root && await exists(join(path, '.git')) && !allowed.has(pathIdentity(path))) {
        throw new WorktreeRemovalError(`存在未纳入删除计划的嵌套仓库：${path}`);
      }
      for (const name of (await readdir(path)).sort()) {
        if (name !== '.git') {
          await visit(join(path, name));
        }
      }
    }
  }

  await visit(root);
  return hash.digest('hex');
}

/** Inactive submodules retain Git databases too; linked consumers must remain protected. */
async function inspectStoredSubmodules(directory: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const info = await exists(directory);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    return '';
  }
  let topology = '';
  if (await exists(join(directory, 'HEAD')) && await exists(join(directory, 'config'))
    && await exists(join(directory, 'objects'))) {
    const listing = await runGit(directory, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ], { signal });
    if (listing.split('\0\0').filter(Boolean).length > 1) {
      throw new WorktreeRemovalError(`子模块 Git 数据仍被其他 worktree 使用：${directory}`);
    }
    topology += directory + listing;
    return topology + await inspectStoredSubmodules(join(directory, 'modules'), signal);
  }
  for (const name of (await readdir(directory)).sort()) {
    topology += await inspectStoredSubmodules(join(directory, name), signal);
  }
  return topology;
}

export async function inspectRemoval(
  worktreePath: string, onFiles?: () => void, signal?: AbortSignal,
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

  async function inspect(path: string) {
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
    if (main && !containsPath(root, commonDir)) {
      throw new WorktreeRemovalError(`Git 数据位于删除范围外，不能删除：${commonDir}`);
    }
    const status = await runGit(path, [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ], { signal });
    const head = own.find((field) => field.startsWith('HEAD '))?.slice(5);
    const branch = own.find((field) => field.startsWith('branch '))?.slice(7);
    const refs = await runGit(path, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ], { signal });
    const indexPath = await gitIndexPath(path, signal);
    let index = '';
    if (await exists(indexPath)) {
      index = createHash('sha256').update(await readFile(indexPath)).digest('hex');
    }
    targets.push({
      path,
      gitDir,
      commonDir,
      main,
      indexPath,
      head,
      branch,
      detached: own.includes('detached'),
      changes: status.split('\0').some((line) =>
        !!line && !line.startsWith('# ')),
      inventory: '',
      topology: listing + status + refs + index,
    });
    for (const sub of await readSubmodulePaths(path, signal)) {
      const child = resolve(path, sub);
      if (!containsPath(path, child) || child === path) {
        throw new WorktreeRemovalError(`子模块路径越界：${child}`);
      }
      const info = await exists(child);
      if (!info || info.isSymbolicLink() || !await exists(join(child, '.git'))) {
        continue;
      }
      await inspect(child);
    }
  }

  await inspect(root);
  const allowed = new Set(targets.map((target) => pathIdentity(target.path)));
  for (const target of targets) {
    target.topology += await inspectStoredSubmodules(join(target.gitDir, 'modules'), signal);
  }
  onFiles?.();
  for (const target of targets) {
    target.inventory = await inventory(target.path, allowed, signal);
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
export async function cleanWorktree(worktreePath: string, keepWorktreeIncludes: boolean) {
  const root = resolve(worktreePath);
  if (!isAbsolute(worktreePath) || dirname(root) === root
    || (await lstat(root)).isSymbolicLink()
    || pathIdentity(await realpath(root)) !== pathIdentity(root)
    || pathIdentity((await runGit(root, ['rev-parse', '--show-toplevel'])).trim())
    !== pathIdentity(root)) {
    throw new WorktreeRemovalError('必须选择不包含链接的工作树根目录。');
  }
  const allowed = new Set([pathIdentity(root)]);

  async function collect(path: string): Promise<void> {
    if (pathIdentity(await realpath(path)) !== pathIdentity(path)) {
      throw new WorktreeRemovalError(`子模块路径包含链接：${path}`);
    }
    for (const sub of await readSubmodulePaths(path)) {
      const child = resolve(path, sub);
      if (!containsPath(path, child) || child === path) {
        throw new WorktreeRemovalError(`子模块路径越界：${child}`);
      }
      const info = await exists(child);
      if (info && !info.isSymbolicLink() && await exists(join(child, '.git'))) {
        allowed.add(pathIdentity(child));
        await collect(child);
      }
    }
  }

  await collect(root);
  await inventory(root, allowed);
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
  for (const path of links) {
    await unlink(path);
  }
  const excludes = kept.flatMap((path) => {
    // Escape gitignore metacharacters: these exclusions describe literal paths.
    const name = relative(root, path).replaceAll('\\', '/').replace(/[\\*?[\]#! ]/g, '\\$&');
    return ['-e', `/${name}`];
  });
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
export async function deleteWorktree(target: RemovalTarget) {
  await cleanWorktree(target.path, false);
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
