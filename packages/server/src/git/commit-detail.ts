import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitDiffType,
  type FileDiffResponse,
  type GitCommitDetail,
  type GitFileChange,
} from '@glink/protocol/git';

const execFileAsync = promisify(execFile);

async function runGit(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function readCommitDetail(repoPath: string, sha: string): Promise<GitCommitDetail> {
  const metadata = await runGit(repoPath, [
    'show',
    '-s',
    '--no-show-signature',
    '--format=%H%x00%P%x00%B%x00%an%x00%ae%x00%aI',
    sha,
  ]);
  const [
    commitSha,
    parentText,
    message,
    author,
    authorEmail,
    date,
  ] = metadata.split('\0');
  const parents = parentText ? parentText.split(' ') : [];
  const changes = await runGit(repoPath, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '--no-color',
    '-r',
    '-z',
    '-M',
    ...(parents.length ? [parents[0], commitSha] : ['--root', commitSha]),
  ]);
  const fields = changes.split('\0');
  const files: GitFileChange[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const type = fields[index++][0] as GitDiffType;
    const path = fields[index++];
    if (type === GitDiffType.renamed || type === GitDiffType.copied) {
      files.push({ type, originalPath: path, path: fields[index++] });
    } else {
      files.push({ type, path });
    }
  }
  return {
    sha: commitSha,
    parents,
    subject: message.split('\n')[0],
    message: message.trimEnd(),
    author,
    authorEmail,
    authoredAt: date.trim(),
    files,
  };
}

async function readCommitFile(repoPath: string, sha: string, path: string) {
  const entry = await runGit(repoPath, [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    sha,
    '--',
    path,
  ]);
  const [mode, , objectSha] = entry.slice(0, entry.indexOf('\t')).split(' ');
  if (!objectSha) {
    throw new Error('File is not present in the selected commit.');
  }
  if (mode === '160000') {
    return `Subproject commit ${objectSha}\n`;
  }
  return runGit(repoPath, ['cat-file', 'blob', objectSha]);
}

export async function readCommitDiff(
  repoPath: string, sha: string, path: string,
): Promise<FileDiffResponse> {
  const detail = await readCommitDetail(repoPath, sha);
  const file = detail.files.find((entry) => entry.path === path);
  if (!file) {
    throw new Error('File is not part of this commit.');
  }
  const original = detail.parents.length && file.type !== GitDiffType.added
    ? await readCommitFile(repoPath, detail.parents[0], file.originalPath ?? file.path)
    : '';
  const modified = file.type !== GitDiffType.deleted
    ? await readCommitFile(repoPath, detail.sha, file.path)
    : '';
  if (original.includes('\0') || modified.includes('\0')) {
    throw new Error('Binary files cannot be displayed as text.');
  }
  return { original, modified };
}
