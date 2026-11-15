import {
  commitDetailPath,
  commitFilesPath,
  commitFilePath,
  type GitCommitFilesResponse,
  type GitCommitFileResponse,
  commitDiffPath,
  commitGraphPath,
  fileDiffPath,
  gitCommitPath,
  gitIndexPath,
  worktreeStatusPath,
  repositoryOverviewPath,
  type RepositoryOverview,
  type CommitGraphResponse,
  type FileDiffResponse,
  type GitCommitInput,
  type GitCommitDetail,
  type GitIndexAction,
  type WorktreeStatus,
} from '@glink/protocol/git';

export class GitService {
  getCommitFiles(repoPath: string, sha: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ repoPath, sha });
    return this._request<GitCommitFilesResponse>(`${commitFilesPath}?${query}`, { signal });
  }

  getCommitFile(repoPath: string, sha: string, path: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ repoPath, sha, path });
    return this._request<GitCommitFileResponse>(`${commitFilePath}?${query}`, { signal });
  }

  getRepositoryOverview(repoPath: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ repoPath });
    return this._request<RepositoryOverview>(`${repositoryOverviewPath}?${query}`, { signal });
  }

  getCommitDetail(repoPath: string, sha: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ repoPath, sha });
    return this._request<GitCommitDetail>(`${commitDetailPath}?${query}`, { signal });
  }

  getCommitDiff(repoPath: string, sha: string, path: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ repoPath, sha, path });
    return this._request<FileDiffResponse>(`${commitDiffPath}?${query}`, { signal });
  }

  getCommitGraph(
    repoPath: string, limit: number, signal?: AbortSignal,
  ): Promise<CommitGraphResponse> {
    const query = new URLSearchParams({ repoPath, limit: String(limit) });
    return this._request<CommitGraphResponse>(`${commitGraphPath}?${query}`, { signal });
  }

  getWorktreeStatus(repoPath: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ repoPath });
    return this._request<WorktreeStatus>(`${worktreeStatusPath}?${query}`, { signal });
  }

  getFileDiff(repoPath: string, path: string, staged: boolean, signal?: AbortSignal) {
    const query = new URLSearchParams({ repoPath, path, staged: String(staged) });
    return this._request<FileDiffResponse>(`${fileDiffPath}?${query}`, { signal });
  }

  changeIndex(repoPath: string, path: string, action: GitIndexAction) {
    return this._request<void>(gitIndexPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, path, action }),
    });
  }

  commit(repoPath: string, input: GitCommitInput) {
    return this._request<void>(gitCommitPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, ...input }),
    });
  }

  private async _request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const { error } = await response.json() as { error: string };
      throw new Error(error);
    }
    return response.json() as Promise<T>;
  }
}
