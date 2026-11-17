import { describe, expect, it } from 'vitest';
import { GitDiffType, GitIndexAction, type GitFileChange } from '@glink/protocol/git';
import { planGitIndexSelection } from '../src/git/git-index-plan';
import type { GitChangeGroup } from '../src/git/git-change-group';

const files: GitFileChange[] = [
  { path: 'a.txt', type: GitDiffType.modified },
  { path: 'src/b.txt', type: GitDiffType.modified },
  { path: 'src/c.txt', type: GitDiffType.untracked },
  { path: 'src-other/keep.txt', type: GitDiffType.modified },
];
const groups: GitChangeGroup[] = [
  { id: 'primary', repoPath: '/primary', files },
  { id: 'secondary', repoPath: '/secondary', files },
];

describe('Index batches planned from selected source-tree rows', () => {
  it('expands folders and deduplicates descendants in source-tree order', () => {
    /// @case A selected folder overlaps a selected child and a root file is selected first.
    /// @expect Stage each included file once, excluding similarly named sibling folders.
    const plan = planGitIndexSelection(groups, [
      { group: 'primary', path: 'a.txt' },
      { group: 'primary', path: 'src/c.txt' },
      { group: 'primary', path: 'src' },
    ], GitIndexAction.stage);
    expect(plan).toEqual([{
      group: 'primary',
      paths: ['src/b.txt', 'src/c.txt', 'a.txt'],
    }]);
  });

  it('groups identical relative paths by their worktree', () => {
    /// @case Both projects select the same relative path in reverse click order.
    /// @expect Produce one batch per owner in displayed project order.
    const plan = planGitIndexSelection(groups, [
      { group: 'secondary', path: 'src/b.txt' },
      { group: 'primary', path: 'src/b.txt' },
    ], GitIndexAction.unstage);
    expect(plan).toEqual([
      { group: 'primary', paths: ['src/b.txt'] },
      { group: 'secondary', paths: ['src/b.txt'] },
    ]);
  });

  it('skips dirty pointers while still staging ordinary selected files', () => {
    /// @case A mixed selection includes a dirty submodule pointer and an ordinary change.
    /// @expect Only the ordinary file is eligible; an all-blocked selection has no action.
    const dirty = { path: 'child', type: GitDiffType.modified, stageBlockedReason: 'Dirty child' };
    const source = [{ id: 'primary', repoPath: '/primary', files: [...files, dirty] }];
    expect(planGitIndexSelection(source, [
      { group: 'primary', path: 'child' },
      { group: 'primary', path: 'a.txt' },
    ], GitIndexAction.stage)).toEqual([{ group: 'primary', paths: ['a.txt'] }]);
    expect(planGitIndexSelection(source, [
      { group: 'primary', path: 'child' },
    ], GitIndexAction.stage)).toEqual([]);
    expect(planGitIndexSelection(source, [
      { group: 'primary', path: 'child' },
    ], GitIndexAction.unstage)).toEqual([{ group: 'primary', paths: ['child'] }]);
  });

  it('ignores selections no longer in the source snapshot', () => {
    /// @case A refresh removes an owner or a file while its old menu selection exists.
    /// @expect No unrelated file is staged as a replacement.
    expect(planGitIndexSelection(groups.slice(0, 1), [
      { group: 'secondary', path: 'src' },
      { group: 'primary', path: 'missing.txt' },
    ], GitIndexAction.stage)).toEqual([]);
  });
});
