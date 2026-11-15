import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  commitDetailPath,
  commitDiffPath,
  commitFilesPath,
  commitFilePath,
  fileDiffPath,
  gitCommitPath,
  gitIndexPath,
  worktreeStatusPath,
  repositoryOverviewPath,
  type FileDiffResponse,
  type GitCommitDetail,
  type WorktreeStatus,
  type RepositoryOverview,
  type GitCommitFilesResponse,
  type GitCommitFileResponse,
} from '@glink/protocol/git';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/request-handler.ts';

const execFileAsync = promisify(execFile);

describe('Worktree HTTP operations against real Git repositories', () => {
  const server = createServer(handleRequest);
  const temporaryPrefix = join(tmpdir(), 'glink-worktree-');
  let origin: string;
  let repoPath: string;

  async function git(...args: string[]) {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trim();
  }

  async function get<T>(route: string, query: Record<string, string> = {}) {
    const response = await fetch(`${origin}${route}?${new URLSearchParams({ repoPath, ...query })}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }

  async function post(route: string, input: Record<string, unknown>) {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, ...input }),
    });
    expect(await response.json()).toEqual({});
    expect(response.status).toBe(200);
  }

  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address.');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    repoPath = await mkdtemp(temporaryPrefix);
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Glink Test');
    await git('config', 'user.email', 'test@glink.local');
    await git('config', 'commit.gpgsign', 'false');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(join(repoPath, 'file.txt'), 'original\n');
    await git('add', '--', 'file.txt');
    await git('commit', '-m', 'Initial');
  });

  afterEach(async () => {
    if (!repoPath.startsWith(temporaryPrefix)) {
      throw new Error('Unexpected temporary repository path.');
    }
    await rm(repoPath, { recursive: true, force: true });
  });

  afterAll(async () => {
    await new Promise<void>((fulfill, reject) => {
      server.close((error) => error ? reject(error) : fulfill());
    });
  });

  it('reports branches, peeled tags, remotes, stashes, and linked worktrees', async () => {
    /// @case A repo has branches, remotes, an annotated tag, a stash, and a locked worktree.
    /// @expect Navigation reflects Git state and tags point to commits rather than tag objects.
    const head = await git('rev-parse', 'HEAD');
    await git('branch', 'feature/test');
    await git('tag', '-a', 'v1.0', '-m', 'Release');
    await git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
    await git('update-ref', 'refs/remotes/origin/main', head);
    await writeFile(join(repoPath, 'file.txt'), 'saved work\n');
    await git('stash', 'push', '-m', 'Saved work');
    const linkedPath = join(repoPath, 'linked');
    await git('worktree', 'add', '-b', 'linked', linkedPath);
    await git('worktree', 'lock', '--reason', 'Test lock', linkedPath);
    const overview = await get<RepositoryOverview>(repositoryOverviewPath);
    expect(overview.rootPath.replace(/\\/g, '/')).toBe(repoPath.replace(/\\/g, '/'));
    expect(overview.branches).toContainEqual({ name: 'main', sha: head, current: true });
    expect(overview.branches).toContainEqual({ name: 'feature/test', sha: head, current: false });
    expect(overview.tags).toContainEqual({ name: 'v1.0', sha: head, current: false });
    expect(overview.remotes).toEqual([{
      name: 'origin',
      fetchUrl: 'https://example.invalid/repo.git',
      branches: [{ name: 'origin/main', sha: head, current: false }],
    }]);
    expect(overview.stashes[0]).toMatchObject({
      name: 'stash@{0}',
      subject: 'On main: Saved work',
    });
    expect(overview.worktrees.filter((entry) => entry.current)).toHaveLength(1);
    expect(overview.worktrees.find((entry) => entry.branch === 'linked'))
      .toMatchObject({ locked: true, current: false, detached: false });
  });

  it('reports whether submodules have an initialized working copy', async () => {
    /// @case A local submodule is cloned and subsequently deinitialized.
    /// @expect Navigation retains its gitlink but distinguishes whether it can be opened.
    const source = join(repoPath, 'library-source');
    await execFileAsync('git', [
      'init',
      '-b',
      'main',
      source,
    ], { windowsHide: true });
    await writeFile(join(source, 'library.txt'), 'library\n');
    await execFileAsync('git', [
      '-C',
      source,
      'add',
      '.',
    ], { windowsHide: true });
    await execFileAsync('git', [
      '-C',
      source,
      '-c',
      'user.name=Glink Test',
      '-c',
      'user.email=test@glink.local',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Library',
    ], { windowsHide: true });
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'deps/library');
    let overview = await get<RepositoryOverview>(repositoryOverviewPath);
    expect(overview.submodules).toEqual([expect.objectContaining({
      path: 'deps/library',
      initialized: true,
    })]);
    await git('submodule', 'deinit', '-f', '--', 'deps/library');
    overview = await get<RepositoryOverview>(repositoryOverviewPath);
    expect(overview.submodules).toEqual([expect.objectContaining({
      path: 'deps/library',
      initialized: false,
    })]);
  });

  it('keeps HEAD, index, and working tree contents separate', async () => {
    /// @case A file is changed, staged, and then changed again alongside an untracked Unicode path.
    /// @expect Each diff compares the correct pair; unstaging preserves the working file.
    await writeFile(join(repoPath, 'file.txt'), 'staged\n');
    await post(gitIndexPath, { path: 'file.txt', action: 'stage' });
    await writeFile(join(repoPath, 'file.txt'), 'working\n');
    await writeFile(join(repoPath, 'new [1] 文件.txt'), 'new\n');
    const status = await get<WorktreeStatus>(worktreeStatusPath);
    expect(status.staged).toEqual([{ path: 'file.txt', type: 'M' }]);
    expect(status.unstaged).toEqual(expect.arrayContaining([
      { path: 'file.txt', type: 'M' },
      { path: 'new [1] 文件.txt', type: '?' },
    ]));
    expect(await get<FileDiffResponse>(fileDiffPath, { path: 'file.txt', staged: 'true' }))
      .toEqual({ original: 'original\n', modified: 'staged\n' });
    expect(await get<FileDiffResponse>(fileDiffPath, { path: 'file.txt', staged: 'false' }))
      .toEqual({ original: 'staged\n', modified: 'working\n' });
    await post(gitIndexPath, { path: 'file.txt', action: 'unstage' });
    expect((await get<WorktreeStatus>(worktreeStatusPath)).staged).toEqual([]);
    expect(await readFile(join(repoPath, 'file.txt'), 'utf8')).toBe('working\n');
    await post(gitIndexPath, { path: 'new [1] 文件.txt', action: 'stage' });
    expect(await git('show', ':new [1] 文件.txt')).toBe('new');
  });

  it('compares staged renames and later edits using their correct paths', async () => {
    /// @case A file is renamed in the index and then edited in the working tree.
    /// @expect Staged diff uses the old HEAD path; unstaged diff uses the new index path.
    await git('mv', 'file.txt', 'renamed 文件.txt');
    await writeFile(join(repoPath, 'renamed 文件.txt'), 'after rename\n');
    const status = await get<WorktreeStatus>(worktreeStatusPath);
    expect(status.staged[0]).toMatchObject({
      path: 'renamed 文件.txt',
      originalPath: 'file.txt',
      type: 'R',
    });
    expect(await get<FileDiffResponse>(fileDiffPath, { path: 'renamed 文件.txt', staged: 'true' }))
      .toEqual({ original: 'original\n', modified: 'original\n' });
    expect(await get<FileDiffResponse>(fileDiffPath, { path: 'renamed 文件.txt', staged: 'false' }))
      .toEqual({ original: 'original\n', modified: 'after rename\n' });
    await post(gitIndexPath, { path: 'renamed 文件.txt', action: 'unstage' });
    expect((await get<WorktreeStatus>(worktreeStatusPath)).staged).toEqual([]);
    expect(await readFile(join(repoPath, 'renamed 文件.txt'), 'utf8')).toBe('after rename\n');
  });

  it('commits only the index and amends without absorbing unstaged edits', async () => {
    /// @case A file has staged and unstaged edits; the message includes a description.
    /// @expect Commit uses only the index. Amend replaces HEAD and preserves unstaged edits.
    await writeFile(join(repoPath, 'file.txt'), 'staged\n');
    await post(gitIndexPath, { path: 'file.txt', action: 'stage' });
    await writeFile(join(repoPath, 'file.txt'), 'keep unstaged\n');
    await post(gitCommitPath, { message: '更新\n\nDetailed message', amend: false });
    expect(await git('show', 'HEAD:file.txt')).toBe('staged');
    expect(await git('log', '-1', '--format=%B')).toBe('更新\n\nDetailed message');
    const previous = await git('rev-parse', 'HEAD');
    await post(gitCommitPath, { message: 'Amended\n\nNew description', amend: true });
    expect(await git('rev-parse', 'HEAD')).not.toBe(previous);
    expect(await git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(await git('show', 'HEAD:file.txt')).toBe('staged');
    expect(await readFile(join(repoPath, 'file.txt'), 'utf8')).toBe('keep unstaged\n');
  });

  it('can stage and unstage before the first commit without deleting files', async () => {
    /// @case A repository without HEAD stages a new file and edits it before unstaging.
    /// @expect Unstage removes only the index entry and leaves the latest working content intact.
    const parent = repoPath;
    repoPath = join(parent, 'unborn');
    try {
      await execFileAsync('git', [
        'init',
        '-b',
        'main',
        repoPath,
      ], { windowsHide: true });
      await writeFile(join(repoPath, 'new.txt'), 'first\n');
      expect((await get<WorktreeStatus>(worktreeStatusPath)).headMessage).toBeUndefined();
      await post(gitIndexPath, { path: 'new.txt', action: 'stage' });
      await writeFile(join(repoPath, 'new.txt'), 'second\n');
      await post(gitIndexPath, { path: 'new.txt', action: 'unstage' });
      expect(await readFile(join(repoPath, 'new.txt'), 'utf8')).toBe('second\n');
      expect((await get<WorktreeStatus>(worktreeStatusPath)).unstaged)
        .toEqual([{ path: 'new.txt', type: '?' }]);
    } finally {
      repoPath = parent;
    }
  });

  it('represents additions and deletions with an empty side', async () => {
    /// @case One tracked file is deleted and a new file is untracked.
    /// @expect Deleted files compare against empty content; new files compare from empty content.
    await rm(join(repoPath, 'file.txt'));
    await writeFile(join(repoPath, 'added.txt'), 'added\n');
    expect(await get<FileDiffResponse>(fileDiffPath, { path: 'file.txt', staged: 'false' }))
      .toEqual({ original: 'original\n', modified: '' });
    expect(await get<FileDiffResponse>(fileDiffPath, { path: 'added.txt', staged: 'false' }))
      .toEqual({ original: '', modified: 'added\n' });
    await post(gitIndexPath, { path: 'file.txt', action: 'stage' });
    expect(await get<FileDiffResponse>(fileDiffPath, { path: 'file.txt', staged: 'true' }))
      .toEqual({ original: 'original\n', modified: '' });
  });

  it('uses the selected linked worktree index rather than the main checkout index', async () => {
    /// @case A linked worktree stages a change while the main checkout remains clean.
    /// @expect Status and diff belong to the selected working copy.
    const mainPath = repoPath;
    const linkedPath = join(mainPath, 'linked');
    await git('worktree', 'add', '-b', 'linked', linkedPath);
    repoPath = linkedPath;
    try {
      await writeFile(join(repoPath, 'file.txt'), 'linked\n');
      await post(gitIndexPath, { path: 'file.txt', action: 'stage' });
      expect((await get<WorktreeStatus>(worktreeStatusPath)).staged).toHaveLength(1);
      expect(await get<FileDiffResponse>(fileDiffPath, { path: 'file.txt', staged: 'true' }))
        .toEqual({ original: 'original\n', modified: 'linked\n' });
    } finally {
      repoPath = mainPath;
    }
    expect((await get<WorktreeStatus>(worktreeStatusPath)).staged).toEqual([]);
  });

  it('shows root commit metadata and compares its added files from empty content', async () => {
    /// @case The selected commit has no parents and the working file has newer uncommitted edits.
    /// @expect Metadata and diff come from the commit; the working file is never used.
    const sha = await git('rev-parse', 'HEAD');
    await writeFile(join(repoPath, 'file.txt'), 'uncommitted\n');
    const detail = await get<GitCommitDetail>(commitDetailPath, { sha });
    expect(detail).toMatchObject({
      sha,
      parents: [],
      subject: 'Initial',
      message: 'Initial',
      author: 'Glink Test',
      authorEmail: 'test@glink.local',
      files: [{ type: 'A', path: 'file.txt' }],
    });
    expect(await get<FileDiffResponse>(commitDiffPath, { sha, path: 'file.txt' }))
      .toEqual({ original: '', modified: 'original\n' });
  });

  it('browses full snapshots independently of newer commits and working files', async () => {
    /// @case A commit includes unchanged text, a Unicode path, binary data and a submodule gitlink.
    /// @expect Files lists the full tree and distinguishes text, binary and gitlink entries.
    const initial = await git('rev-parse', 'HEAD');
    await writeFile(join(repoPath, '文件 [1].txt'), 'snapshot\n');
    await writeFile(join(repoPath, 'binary.dat'), Buffer.from([
      0,
      1,
      2,
      255,
    ]));
    await git('add', '--', '文件 [1].txt', 'binary.dat');
    await git('update-index', '--add', '--cacheinfo', `160000,${initial},vendor/library`);
    await git('commit', '-m', 'Snapshot');
    const sha = await git('rev-parse', 'HEAD');
    await git('rm', '--', '文件 [1].txt');
    await writeFile(join(repoPath, 'file.txt'), 'newer\n');
    await git('add', '--', 'file.txt');
    await git('commit', '-m', 'Later changes');
    await writeFile(join(repoPath, 'file.txt'), 'uncommitted\n');
    const tree = await get<GitCommitFilesResponse>(commitFilesPath, { sha });
    expect(tree.files.map((file) => file.path)).toEqual([
      'binary.dat',
      'file.txt',
      'vendor/library',
      '文件 [1].txt',
    ]);
    const detail = await get<GitCommitDetail>(commitDetailPath, { sha });
    expect(detail.files.some((file) => file.path === 'file.txt')).toBe(false);
    expect(await get<GitCommitFileResponse>(commitFilePath, { sha, path: 'file.txt' }))
      .toEqual({ content: 'original\n', binary: false });
    expect(await get<GitCommitFileResponse>(commitFilePath, { sha, path: '文件 [1].txt' }))
      .toEqual({ content: 'snapshot\n', binary: false });
    expect(await get<GitCommitFileResponse>(commitFilePath, { sha, path: 'binary.dat' }))
      .toEqual({ content: '', binary: true });
    expect(await get<GitCommitFileResponse>(commitFilePath, { sha, path: 'vendor/library' }))
      .toEqual({ content: `Subproject commit ${initial}\n`, binary: false });
    const newer = await get<GitCommitFilesResponse>(commitFilesPath,
      { sha: await git('rev-parse', 'HEAD') });
    expect(newer.files.some((file) => file.path === '文件 [1].txt')).toBe(false);
    const missing = await fetch(`${origin}${commitFilePath}?${new URLSearchParams({
      repoPath,
      sha,
      path: 'missing.txt',
    })}`);
    expect(missing.ok).toBe(false);
  });

  it('reads historical renames, additions, edits, and deletions across commits', async () => {
    /// @case Commits rename a Unicode path, add a file, then edit and delete files.
    /// @expect Each file diff uses the selected commit and its parent, including renamed old paths.
    await git('mv', 'file.txt', 'renamed [1] 文件.txt');
    await writeFile(join(repoPath, 'added.txt'), 'added\n');
    await git('add', '--', 'added.txt');
    await git('commit', '-m', '改名\n\nFull description');
    const renamedSha = await git('rev-parse', 'HEAD');
    const detail = await get<GitCommitDetail>(commitDetailPath, { sha: renamedSha });
    expect(detail.message).toBe('改名\n\nFull description');
    expect(detail.files).toContainEqual({
      type: 'R',
      path: 'renamed [1] 文件.txt',
      originalPath: 'file.txt',
    });
    expect(await get<FileDiffResponse>(commitDiffPath, {
      sha: renamedSha,
      path: 'renamed [1] 文件.txt',
    })).toEqual({ original: 'original\n', modified: 'original\n' });
    expect(await get<FileDiffResponse>(commitDiffPath, { sha: renamedSha, path: 'added.txt' }))
      .toEqual({ original: '', modified: 'added\n' });
    await writeFile(join(repoPath, 'renamed [1] 文件.txt'), 'updated\n');
    await rm(join(repoPath, 'added.txt'));
    await git('add', '-A');
    await git('commit', '-m', 'Edit and delete');
    const sha = await git('rev-parse', 'HEAD');
    expect(await get<FileDiffResponse>(commitDiffPath, { sha, path: 'renamed [1] 文件.txt' }))
      .toEqual({ original: 'original\n', modified: 'updated\n' });
    expect(await get<FileDiffResponse>(commitDiffPath, { sha, path: 'added.txt' }))
      .toEqual({ original: 'added\n', modified: '' });
  });

  it('compares merge commits against their first parent', async () => {
    /// @case A side branch changes a file while main adds an unrelated file before merging.
    /// @expect Both parents are reported; only the side branch changes appear in the merge diff.
    await git('checkout', '-b', 'side');
    await writeFile(join(repoPath, 'file.txt'), 'feature\n');
    await git('add', '--', 'file.txt');
    await git('commit', '-m', 'Feature');
    const side = await git('rev-parse', 'HEAD');
    await git('checkout', 'main');
    await writeFile(join(repoPath, 'main.txt'), 'main\n');
    await git('add', '--', 'main.txt');
    await git('commit', '-m', 'Main');
    const main = await git('rev-parse', 'HEAD');
    await git('merge', '--no-ff', 'side', '-m', 'Merge');
    const sha = await git('rev-parse', 'HEAD');
    const detail = await get<GitCommitDetail>(commitDetailPath, { sha });
    expect(detail.parents).toEqual([main, side]);
    expect(detail.files).toEqual([{ type: 'M', path: 'file.txt' }]);
    expect(await get<FileDiffResponse>(commitDiffPath, { sha, path: 'file.txt' }))
      .toEqual({ original: 'original\n', modified: 'feature\n' });
  });
});
