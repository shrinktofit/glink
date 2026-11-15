import type { InjectionKey } from 'vue';
import { commitGraphLimit, type GitCommitInput, type GitIndexAction } from '@glink/protocol/git';
import type { GitService } from './git-service';

export const gitRepoServiceKey: InjectionKey<GitRepoService> = Symbol('gitRepoService');

export class GitRepoService {
  constructor(gitService: GitService, repoPath: string) {
    this.gitService = gitService;
    this.repoPath = repoPath;
  }

  readonly repoPath: string;
  readonly gitService: GitService;

  getRepositoryOverview(signal?: AbortSignal) {
    return this.gitService.getRepositoryOverview(this.repoPath, signal);
  }

  getCommitFiles(sha: string, signal?: AbortSignal) {
    return this.gitService.getCommitFiles(this.repoPath, sha, signal);
  }

  getCommitFile(sha: string, path: string, signal?: AbortSignal) {
    return this.gitService.getCommitFile(this.repoPath, sha, path, signal);
  }

  getCommitGraph(maxCommits = commitGraphLimit, signal?: AbortSignal) {
    return this.gitService.getCommitGraph(
      this.repoPath, Math.min(maxCommits, commitGraphLimit), signal,
    );
  }

  getWorktreeStatus(signal?: AbortSignal) {
    return this.gitService.getWorktreeStatus(this.repoPath, signal);
  }

  getCommitDetail(sha: string, signal?: AbortSignal) {
    return this.gitService.getCommitDetail(this.repoPath, sha, signal);
  }

  getCommitDiff(sha: string, path: string, signal?: AbortSignal) {
    return this.gitService.getCommitDiff(this.repoPath, sha, path, signal);
  }

  getFileDiff(path: string, staged: boolean, signal?: AbortSignal) {
    return this.gitService.getFileDiff(this.repoPath, path, staged, signal);
  }

  changeIndex(path: string, action: GitIndexAction) {
    return this.gitService.changeIndex(this.repoPath, path, action);
  }

  commit(input: GitCommitInput) {
    return this.gitService.commit(this.repoPath, input);
  }
}
