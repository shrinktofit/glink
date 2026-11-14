import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitGraphPath, type CommitGraphResponse } from '@glink/protocol/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/request-handler.ts';

const execFileAsync = promisify(execFile);

describe('Commit graph HTTP API with a real Git repository', () => {
  const server = createServer(handleRequest);
  let repoPath: string;
  let origin: string;
  let mergeSha: string;
  let parentShas: string[];

  async function git(...args: string[]) {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trim();
  }

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'glink graph '));
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Glink 测试');
    await git('config', 'user.email', 'test@glink.local');
    await git('config', 'commit.gpgsign', 'false');
    await git('commit', '--allow-empty', '-m', 'Root');
    await git('checkout', '-b', 'side');
    await git('commit', '--allow-empty', '-m', 'Side | 分支');
    const sideSha = await git('rev-parse', 'HEAD');
    await git('checkout', 'main');
    await git('commit', '--allow-empty', '-m', 'Main');
    const mainSha = await git('rev-parse', 'HEAD');
    await git('merge', '--no-ff', 'side', '-m', 'Merge');
    mergeSha = await git('rev-parse', 'HEAD');
    parentShas = [mainSha, sideSha];
    const tree = await git('rev-parse', 'HEAD^{tree}');
    const checkpoint = await git('commit-tree', tree, '-p', mergeSha, '-m', 'Internal checkpoint');
    await git('update-ref', 'refs/t3/test-checkpoint', checkpoint);

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The test server must listen on a TCP port.');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((fulfill, reject) => {
      server.close((error) => error ? reject(error) : fulfill());
    });
    await rm(repoPath, { recursive: true, force: true });
  });

  it('preserves merges and Unicode while excluding internal refs', async () => {
    /// @case A repository has divergent branches, a merge, and a T3-only checkpoint.
    /// @expect Real branch history preserves both merge parents and intact metadata.
    const query = new URLSearchParams({ repoPath, limit: '500' });
    const response = await fetch(`${origin}${commitGraphPath}?${query}`);
    expect(response.status).toBe(200);
    const { commits } = await response.json() as CommitGraphResponse;
    expect(commits).toHaveLength(4);
    expect(commits[0]).toMatchObject({
      sha: mergeSha,
      parents: parentShas,
      subject: 'Merge',
      author: 'Glink 测试',
    });
    expect(commits.some((commit) => commit.subject === 'Side | 分支')).toBe(true);
    const positions = new Map(commits.map((commit, index) => [commit.sha, index]));
    for (const [index, commit] of commits.entries()) {
      expect(Number.isNaN(Date.parse(commit.authoredAt))).toBe(false);
      for (const parent of commit.parents) {
        expect(positions.get(parent)).toBeGreaterThan(index);
      }
    }
  });

  it('honors the requested commit count while preserving parents outside the result', async () => {
    /// @case A client requests one commit from a history containing a merge.
    /// @expect Only the merge is returned, with both parent SHAs for graph continuation.
    const query = new URLSearchParams({ repoPath, limit: '1' });
    const response = await fetch(`${origin}${commitGraphPath}?${query}`);
    expect(response.status).toBe(200);
    const { commits } = await response.json() as CommitGraphResponse;
    expect(commits).toHaveLength(1);
    expect(commits[0].parents).toEqual(parentShas);
  });

  it.each([
    '0',
    '-1',
    '501',
    '1.5',
    'NaN',
  ])('rejects an invalid limit of %s', async (limit) => {
    /// @case A client supplies an invalid count or asks for more than 500 commits.
    /// @expect The API rejects the request before running Git.
    const query = new URLSearchParams({ repoPath, limit });
    const response = await fetch(`${origin}${commitGraphPath}?${query}`);
    expect(response.status).toBe(400);
  });

  it('returns an empty graph for a repository without commits', async () => {
    /// @case A newly initialized repository has no HEAD or branch commits.
    /// @expect The history is empty rather than an API failure.
    const emptyPath = join(repoPath, 'empty');
    await git('init', emptyPath);
    const query = new URLSearchParams({ repoPath: emptyPath });
    const response = await fetch(`${origin}${commitGraphPath}?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commits: [] });
  });
});
