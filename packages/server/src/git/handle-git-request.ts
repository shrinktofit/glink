import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  commitDetailPath,
  commitDiffPath,
  commitFilesPath,
  commitFilePath,
  commitGraphLimit,
  commitGraphPath,
  fileDiffPath,
  gitCommitPath,
  gitIndexPath,
  GitIndexAction,
  worktreeStatusPath,
  repositoryOverviewPath,
} from '@glink/protocol/git';
import { readCommits } from './read-commits.ts';
import { readRepositoryOverview } from './repository-overview.ts';
import {
  readCommitDetail,
  readCommitDiff,
  readCommitFiles,
  readCommitFileContent,
} from './commit-detail.ts';
import { GitIndexLockedError } from './git-index-locked-error.ts';
import { GitSubmoduleDirtyError } from './git-submodule-dirty-error.ts';
import { changeIndex, commitWorktree, readFileDiff, readWorktreeStatus } from './worktree.ts';

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function handleGitRequest(
  request: IncomingMessage, response: ServerResponse, url: URL,
): Promise<void> {
  const readRoutes = [
    commitGraphPath,
    worktreeStatusPath,
    fileDiffPath,
    commitDetailPath,
    commitDiffPath,
    commitFilesPath,
    commitFilePath,
    repositoryOverviewPath,
  ];
  const writeRoutes = [gitIndexPath, gitCommitPath];
  const isRead = readRoutes.includes(url.pathname);
  if (!isRead && !writeRoutes.includes(url.pathname)) {
    response.writeHead(404).end();
    return;
  }
  const method = isRead ? 'GET' : 'POST';
  if (request.method !== method) {
    response.writeHead(405, { Allow: method }).end();
    return;
  }

  let body: Record<string, unknown> = {};
  if (!isRead) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
      sendJson(response, 415, { error: 'Expected application/json.' });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected a JSON object.');
      }
      body = parsed as Record<string, unknown>;
    } catch {
      sendJson(response, 400, { error: 'Invalid JSON request.' });
      return;
    }
  }
  const repoPath = isRead ? url.searchParams.get('repoPath') : body.repoPath;
  if (typeof repoPath !== 'string' || !repoPath) {
    sendJson(response, 400, { error: 'repoPath is required.' });
    return;
  }

  try {
    switch (url.pathname) {
    case repositoryOverviewPath:
      sendJson(response, 200, await readRepositoryOverview(repoPath));
      break;
    case commitDetailPath:
    case commitDiffPath:
    case commitFilesPath:
    case commitFilePath: {
      const sha = url.searchParams.get('sha');
      if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) {
        sendJson(response, 400, { error: 'A full commit SHA is required.' });
        return;
      }
      if (url.pathname === commitDetailPath) {
        sendJson(response, 200, await readCommitDetail(repoPath, sha));
      } else if (url.pathname === commitFilesPath) {
        sendJson(response, 200, await readCommitFiles(repoPath, sha));
      } else {
        const path = url.searchParams.get('path');
        if (!path) {
          sendJson(response, 400, { error: 'path is required.' });
          return;
        }
        sendJson(response, 200, url.pathname === commitFilePath
          ? await readCommitFileContent(repoPath, sha, path)
          : await readCommitDiff(repoPath, sha, path));
      }
      break;
    }
    case commitGraphPath: {
      const limit = Number(url.searchParams.get('limit') ?? commitGraphLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > commitGraphLimit) {
        sendJson(response, 400, { error: `limit must be between 1 and ${commitGraphLimit}.` });
        return;
      }
      sendJson(response, 200, { commits: await readCommits(repoPath, limit) });
      break;
    }
    case worktreeStatusPath:
      sendJson(response, 200, await readWorktreeStatus(repoPath));
      break;
    case fileDiffPath: {
      const path = url.searchParams.get('path');
      const staged = url.searchParams.get('staged');
      if (!path || (staged !== 'true' && staged !== 'false')) {
        sendJson(response, 400, { error: 'path and staged are required.' });
        return;
      }
      sendJson(response, 200, await readFileDiff(repoPath, path, staged === 'true'));
      break;
    }
    case gitIndexPath:
      if (typeof body.path !== 'string' || !body.path
        || (body.action !== GitIndexAction.stage && body.action !== GitIndexAction.unstage)) {
        sendJson(response, 400, { error: 'path and a valid index action are required.' });
        return;
      }
      await changeIndex(repoPath, body.path, body.action);
      sendJson(response, 200, {});
      break;
    case gitCommitPath:
      if (typeof body.message !== 'string' || !body.message.trim()
        || typeof body.amend !== 'boolean') {
        sendJson(response, 400, { error: 'message and amend are required.' });
        return;
      }
      await commitWorktree(repoPath, { message: body.message, amend: body.amend });
      sendJson(response, 200, {});
      break;
    }
  } catch (error: unknown) {
    if (error instanceof GitIndexLockedError || error instanceof GitSubmoduleDirtyError) {
      sendJson(response, 409, { error: error.message });
      return;
    }
    console.error('Git request failed:', error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
