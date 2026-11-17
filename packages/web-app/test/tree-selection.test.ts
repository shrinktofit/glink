import { describe, expect, it } from 'vitest';
import { TreeSelection } from '../src/components/tree-selection';

describe('Desktop tree selection in visible row order', () => {
  const rows = [
    'folder',
    'folder/a',
    'folder/b',
    'last',
  ];

  it('toggles selected rows independently of the current row', () => {
    /// @case Select two rows with Ctrl, then Ctrl-click the second row again.
    /// @expect Only the second row is deselected; it remains the current row for preview.
    const selection = new TreeSelection();
    selection.select('folder/a', rows);
    selection.select('folder/b', rows, { additive: true });
    expect([...selection.selectedKeys]).toEqual(['folder/a', 'folder/b']);
    selection.select('folder/b', rows, { additive: true });
    expect([...selection.selectedKeys]).toEqual(['folder/a']);
    expect(selection.current).toBe('folder/b');
    selection.select('last', rows);
    expect([...selection.selectedKeys]).toEqual(['last']);
  });

  it('extends and shrinks ranges from the original anchor in either direction', () => {
    /// @case Repeated Shift-clicks move the endpoint around a fixed starting row.
    /// @expect Each range replaces the previous range without moving the anchor.
    const selection = new TreeSelection();
    selection.select('folder/a', rows);
    selection.select('last', rows, { range: true });
    expect([...selection.selectedKeys]).toEqual(['folder/a', 'folder/b', 'last']);
    selection.select('folder/b', rows, { range: true });
    expect([...selection.selectedKeys]).toEqual(['folder/a', 'folder/b']);
    selection.select('folder', rows, { range: true });
    expect([...selection.selectedKeys]).toEqual(['folder', 'folder/a']);
    expect(selection.anchor).toBe('folder/a');
  });

  it('adds a Ctrl-Shift range to a disjoint selection', () => {
    /// @case An additional range follows an earlier isolated selection.
    /// @expect Existing selected rows survive and every visible row in the new range is added.
    const selection = new TreeSelection();
    selection.select('folder', rows);
    selection.select('folder/b', rows, { additive: true });
    selection.select('last', rows, { additive: true, range: true });
    expect([...selection.selectedKeys]).toEqual(['folder', 'folder/b', 'last']);
  });

  it('uses visible rows across projects and excludes collapsed or disabled rows', () => {
    /// @case A cross-project range skips a collapsed folder's children and an in-progress file.
    /// @expect Only available visible rows participate, with distinct keys for identical paths.
    const selection = new TreeSelection();
    const visible = ['project-a/folder', 'project-a/same.txt', 'project-b/same.txt'];
    selection.select('project-a/folder', visible);
    selection.select('project-b/same.txt', visible, { range: true });
    expect([...selection.selectedKeys]).toEqual(visible);
    selection.select('project-a/disabled.txt', visible, { additive: true });
    expect([...selection.selectedKeys]).toEqual(visible);
  });

  it('starts a new range when both anchor and current row are hidden', () => {
    /// @case The selected child becomes hidden when its folder is collapsed.
    /// @expect Shift-clicking outside starts at the clicked row instead of selecting from index -1.
    const selection = new TreeSelection();
    selection.select('folder/a', rows);
    selection.select('last', ['folder', 'last'], { range: true });
    expect([...selection.selectedKeys]).toEqual(['last']);
  });

  it('keeps a selected set on right-click, but replaces it for an unselected row', () => {
    /// @case Open a menu first on an already selected row, then on a different row.
    /// @expect Context actions retain the existing selection only for a selected target.
    const selection = new TreeSelection();
    selection.selectAll(['folder/a', 'folder/b']);
    selection.openContext('folder/a');
    expect([...selection.selectedKeys]).toEqual(['folder/a', 'folder/b']);
    selection.openContext('last');
    expect([...selection.selectedKeys]).toEqual(['last']);
    expect(selection.current).toBe('last');
  });

  it('prunes removed rows while preserving valid selections across refreshes', () => {
    /// @case A selected file disappears in a completed snapshot; another selected file survives.
    /// @expect Only missing keys, anchors and current rows are discarded.
    const selection = new TreeSelection();
    selection.select('folder/a', rows);
    selection.select('folder/b', rows, { additive: true });
    selection.retain(new Set(['folder', 'folder/a', 'last']));
    expect([...selection.selectedKeys]).toEqual(['folder/a']);
    expect(selection.current).toBeUndefined();
    expect(selection.anchor).toBeUndefined();
    selection.replace('last');
    expect([...selection.selectedKeys]).toEqual(['last']);
  });
});
