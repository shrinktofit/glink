import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitCommit } from '@glink/protocol/git';

const execFileAsync = promisify(execFile);

export async function readCommits(repoPath: string, limit: number): Promise<GitCommit[]> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoPath,
    'log',
    '--ignore-missing',
    'HEAD',
    '--branches',
    '--remotes',
    '--tags',
    '--topo-order',
    `--max-count=${limit}`,
    '--no-show-signature',
    '--format=%H%x00%P%x00%s%x00%an%x00%aI',
    '-z',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });

  const fields = stdout.split('\0');
  const commits: GitCommit[] = [];
  for (let offset = 0; offset < fields.length - 1; offset += 5) {
    const [
      sha,
      parents,
      subject,
      author,
      authoredAt,
    ] = fields.slice(offset, offset + 5);
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      subject,
      author,
      authoredAt,
    });
  }
  return commits;
}
