import { effectScope } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  createFileTreeSelection,
  fileTreeSelectionKey,
} from '../src/components/file-tree-selection';

describe('Selected paths passed to file-tree context actions', () => {
  it('keeps tree order and group identity regardless of selection order', () => {
    /// @case Select the same relative path in two worktrees, starting with the second worktree.
    /// @expect Context actions receive both paths in project and tree order, with distinct owners.
    const effects = effectScope();
    try {
      const scope = effects.run(() => createFileTreeSelection(['primary', 'secondary']))!;
      scope.updateGroup('secondary', ['same.txt'], ['same.txt'], true);
      scope.updateGroup('primary', ['folder', 'folder/a.txt', 'same.txt'], [
        'folder',
        'folder/a.txt',
        'same.txt',
      ], true);
      scope.state.select(fileTreeSelectionKey('secondary', 'same.txt'), scope.visibleKeys.value);
      scope.state.select(fileTreeSelectionKey('primary', 'same.txt'), scope.visibleKeys.value, {
        additive: true,
      });
      scope.state.select(fileTreeSelectionKey('primary', 'folder/a.txt'), scope.visibleKeys.value, {
        additive: true,
      });
      expect(scope.selectedEntries.value).toEqual([
        { group: 'primary', path: 'folder/a.txt' },
        { group: 'primary', path: 'same.txt' },
        { group: 'secondary', path: 'same.txt' },
      ]);
    } finally {
      effects.stop();
    }
  });

  it('provides the current selection synchronously when a context menu opens', () => {
    /// @case Right-click a selected file, then right-click an unselected folder.
    /// @expect The first menu keeps both files; the second immediately receives only the folder.
    const effects = effectScope();
    try {
      const scope = effects.run(() => createFileTreeSelection(['']))!;
      const paths = ['folder', 'folder/a.txt', 'b.txt'];
      scope.updateGroup('', paths, paths, true);
      scope.state.select(fileTreeSelectionKey('', 'folder/a.txt'), scope.visibleKeys.value);
      scope.state.select(fileTreeSelectionKey('', 'b.txt'), scope.visibleKeys.value, {
        additive: true,
      });
      scope.state.openContext(fileTreeSelectionKey('', 'folder/a.txt'));
      expect(scope.selectedEntries.value).toEqual([
        { group: '', path: 'folder/a.txt' },
        { group: '', path: 'b.txt' },
      ]);
      scope.state.openContext(fileTreeSelectionKey('', 'folder'));
      expect(scope.selectedEntries.value).toEqual([{ group: '', path: 'folder' }]);
    } finally {
      effects.stop();
    }
  });
});
