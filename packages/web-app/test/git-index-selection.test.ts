import { describe, expect, it } from 'vitest';
import { GitDiffType, GitIndexAction, type GitFileChange } from '@glink/protocol/git';
import { GitIndexScope } from '../src/git/git-index-target';
import { nextChangeAfterIndex, orderGitChanges } from '../src/git/git-index-selection';

const worktreePath = '/primary';
const change = (path: string): GitFileChange => ({ path, type: GitDiffType.modified });
const files = [
  'a-root.txt',
  'm/b.txt',
  'm/c.txt',
  'z/a.txt',
  'z-root.txt',
].map(change);

describe('Selection after staging or unstaging in file-tree order', () => {
  it('uses folder-first traversal rather than raw Git path order', () => {
    /// @case Git lists a root file before files inside alphabetically later directories.
    /// @expect Selection follows the same directory-first order the user sees in the tree.
    const before = orderGitChanges([{ worktreePath, files }]);
    expect(before.map((entry) => entry.file.path)).toEqual([
      'm/b.txt',
      'm/c.txt',
      'z/a.txt',
      'a-root.txt',
      'z-root.txt',
    ]);
    const after = orderGitChanges([{
      worktreePath,
      files: files.filter((file) => file.path !== 'm/c.txt'),
    }]);
    const next = nextChangeAfterIndex(before, after, [{
      worktreePath,
      action: GitIndexAction.stage,
      scope: GitIndexScope.file,
      path: 'm/c.txt',
    }]);
    expect(next?.file.path).toBe('z/a.txt');
  });

  it.each([GitIndexAction.stage, GitIndexAction.unstage])(
    'continues after the last file in a directory batch: %s', (action) => {
      /// @case A folder operation moves multiple source files at once.
      /// @expect Choose the first surviving file after the entire batch, using fresh row data.
      const before = orderGitChanges([{ worktreePath, files }]);
      const fresh = files.filter((file) => !file.path.startsWith('m/'))
        .map((file) => ({ ...file, type: GitDiffType.deleted }));
      const after = orderGitChanges([{ worktreePath, files: fresh }]);
      const next = nextChangeAfterIndex(before, after, [{
        worktreePath,
        action,
        scope: GitIndexScope.directory,
        path: 'm',
      }]);
      expect(next?.file).toEqual({ path: 'z/a.txt', type: GitDiffType.deleted });
    },
  );

  it('wraps to the first surviving file when the last row is moved', () => {
    /// @case The operation targets the last file in the original tree order.
    /// @expect Circular navigation returns the first remaining file, not an adjacent Git row.
    const before = orderGitChanges([{ worktreePath, files }]);
    const after = orderGitChanges([{
      worktreePath,
      files: files.filter((file) => file.path !== 'z-root.txt'),
    }]);
    expect(nextChangeAfterIndex(before, after, [{
      worktreePath,
      action: GitIndexAction.stage,
      scope: GitIndexScope.file,
      path: 'z-root.txt',
    }])?.file.path).toBe('m/b.txt');
  });

  it('continues across worktrees without confusing identical relative paths', () => {
    /// @case A project batch empties one group and another worktree has the same relative path.
    /// @expect Select the next project in displayed group order with its own current file object.
    const primary = { worktreePath, files: [change('same.txt')] };
    const secondary = { worktreePath: '/secondary', files: [change('same.txt')] };
    const before = orderGitChanges([primary, secondary]);
    const after = orderGitChanges([secondary]);
    expect(nextChangeAfterIndex(before, after, [{
      worktreePath,
      action: GitIndexAction.unstage,
      scope: GitIndexScope.worktree,
    }])).toEqual({ worktreePath: '/secondary', file: change('same.txt') });
  });

  it('keeps blocked dirty submodule pointers as eligible next source rows', () => {
    /// @case A directory batch stages ordinary files but skips a dirty submodule pointer.
    /// @expect The skipped pointer can become the next selected source row after the moved file.
    const blocked = { ...change('m/c.txt'), stageBlockedReason: 'Dirty submodule' };
    const before = orderGitChanges([{
      worktreePath,
      files: [change('m/b.txt'), blocked, change('z.txt')],
    }]);
    const after = orderGitChanges([{ worktreePath, files: [blocked, change('z.txt')] }]);
    expect(nextChangeAfterIndex(before, after, [{
      worktreePath,
      action: GitIndexAction.stage,
      scope: GitIndexScope.directory,
      path: 'm',
    }])?.file.path).toBe('m/c.txt');
  });

  it('advances even when newer edits leave the operated file in the source list', () => {
    /// @case Staging a file still leaves an unstaged version in the returned snapshot.
    /// @expect Continue after that file and only revisit it after a full wrap.
    const before = orderGitChanges([{ worktreePath, files }]);
    const after = orderGitChanges([{ worktreePath, files: files.map((file) => ({ ...file })) }]);
    expect(nextChangeAfterIndex(before, after, [{
      worktreePath,
      action: GitIndexAction.stage,
      scope: GitIndexScope.file,
      path: 'm/b.txt',
    }])?.file.path).toBe('m/c.txt');
  });

  it('selects newly appeared files when no original rows survive', () => {
    /// @case The operation clears every old row while another change appears in the response.
    /// @expect A nonempty source region still has a selection, starting from its first new row.
    const before = orderGitChanges([{ worktreePath, files }]);
    const after = orderGitChanges([{ worktreePath, files: [change('new.txt')] }]);
    expect(nextChangeAfterIndex(before, after, [{
      worktreePath,
      action: GitIndexAction.stage,
      scope: GitIndexScope.worktree,
    }])?.file.path).toBe('new.txt');
  });

  it('clears selection when the source region becomes empty', () => {
    /// @case All files leave the source region after the operation.
    /// @expect No file from the destination region is selected as a replacement.
    const before = orderGitChanges([{ worktreePath, files }]);
    expect(nextChangeAfterIndex(before, [], [{
      worktreePath,
      action: GitIndexAction.unstage,
      scope: GitIndexScope.worktree,
    }])).toBeUndefined();
  });

  it('continues after the last affected file across a multi-worktree batch', () => {
    /// @case Disjoint selected files span two projects with other files between them.
    /// @expect Advance only once, after the last affected row in the complete source order.
    const before = orderGitChanges([
      { worktreePath, files },
      { worktreePath: '/secondary', files: [change('a.txt'), change('z.txt')] },
    ]);
    const after = before.filter((entry) => entry.worktreePath === worktreePath
      ? entry.file.path !== 'm/b.txt'
      : entry.file.path !== 'a.txt');
    expect(nextChangeAfterIndex(before, after, [
      {
        worktreePath,
        action: GitIndexAction.stage,
        scope: GitIndexScope.paths,
        paths: ['m/b.txt'],
      },
      {
        worktreePath: '/secondary',
        action: GitIndexAction.stage,
        scope: GitIndexScope.paths,
        paths: ['a.txt'],
      },
    ])).toEqual({ worktreePath: '/secondary', file: change('z.txt') });
  });
});
