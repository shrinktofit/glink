import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { GitWorktree, RepositoryOverview } from '@glink/protocol/git';

const execFileAsync = promisify(execFile);

export async function readRepositoryOverview(repoPath: string): Promise<RepositoryOverview> {
  async function git(...args: string[]) {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  }

  const refFormat = [
    '%(refname)',
    '%(objectname)',
    '%(*objectname)',
    '%(HEAD)',
    '%(symref)',
    '%(objecttype)',
    '%(*objecttype)',
  ].join('%00');
  const [
    root,
    worktreeText,
    refText,
    remoteText,
    stashText,
    indexText,
  ] = await Promise.all([
    git('rev-parse', '--show-toplevel'),
    git('worktree', 'list', '--porcelain', '-z'),
    git('for-each-ref',
      `--format=${refFormat}`,
      'refs/heads',
      'refs/remotes',
      'refs/tags'),
    git('remote', '-v'),
    git('stash', 'list', '--format=%gd%x00%H%x00%gs'),
    git('ls-files', '--stage', '-z'),
  ]);
  const overview: RepositoryOverview = {
    rootPath: root.trim(),
    worktrees: [],
    branches: [],
    remotes: [],
    tags: [],
    stashes: [],
    submodules: [],
  };
  for (const record of worktreeText.split('\0\0')) {
    if (!record) {
      continue;
    }
    const worktree: GitWorktree = {
      path: '',
      current: false,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    };
    for (const field of record.split('\0')) {
      const separator = field.indexOf(' ');
      const key = separator < 0 ? field : field.slice(0, separator);
      const value = separator < 0 ? '' : field.slice(separator + 1);
      switch (key) {
      case 'worktree':
        worktree.path = value;
        break;
      case 'HEAD':
        worktree.head = value;
        break;
      case 'branch':
        worktree.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        worktree.detached = true;
        break;
      case 'bare':
        worktree.bare = true;
        break;
      case 'locked':
        worktree.locked = true;
        break;
      case 'prunable':
        worktree.prunable = true;
        break;
      }
    }
    worktree.current = process.platform === 'win32'
      ? worktree.path.toLowerCase() === overview.rootPath.toLowerCase()
      : worktree.path === overview.rootPath;
    overview.worktrees.push(worktree);
  }
  for (const line of remoteText.split('\n')) {
    const match = /^(.*?)\t(.*) \(fetch\)$/.exec(line);
    if (match) {
      overview.remotes.push({ name: match[1], fetchUrl: match[2], branches: [] });
    }
  }
  for (const line of refText.split('\n')) {
    if (!line) {
      continue;
    }
    const [
      name,
      sha,
      peeled,
      head,
      symbolic,
      objectType,
      peeledType,
    ] = line.split('\0');
    if (symbolic) {
      continue;
    }
    if (name.startsWith('refs/heads/')) {
      overview.branches.push({ name: name.slice(11), sha, current: head === '*' });
    } else if (name.startsWith('refs/tags/')) {
      if (objectType === 'commit' || peeledType === 'commit') {
        overview.tags.push({ name: name.slice(10), sha: peeled || sha, current: false });
      }
    } else {
      const shortName = name.slice(13);
      const remote = [...overview.remotes].sort((a, b) => b.name.length - a.name.length)
        .find((entry) => shortName.startsWith(`${entry.name}/`));
      if (remote) {
        remote.branches.push({ name: shortName, sha, current: false });
      }
    }
  }
  for (const line of stashText.split('\n')) {
    if (!line) {
      continue;
    }
    const [name, sha, subject] = line.split('\0');
    overview.stashes.push({ name, sha, subject });
  }
  for (const entry of indexText.split('\0')) {
    const match = /^160000 ([a-f0-9]+) 0\t(.*)$/s.exec(entry);
    if (match) {
      overview.submodules.push({ path: match[2], sha: match[1], initialized: false });
    }
  }
  await Promise.all(overview.submodules.map(async (submodule) => {
    try {
      await lstat(join(overview.rootPath, submodule.path, '.git'));
      submodule.initialized = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }));
  return overview;
}
