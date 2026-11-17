export interface TreeSelectionModifiers {
  additive?: boolean;
  range?: boolean;
}

/** Selection and the current row are separate: a Ctrl-click can deselect the current row. */
export class TreeSelection {
  current?: string;
  anchor?: string;

  get selectedKeys() {
    return this._keys;
  }

  replace(key?: string) {
    this._keys = new Set(key === undefined ? [] : [key]);
    this.current = key;
    this.anchor = key;
  }

  select(key: string, visibleKeys: readonly string[], modifiers: TreeSelectionModifiers = {}) {
    if (!visibleKeys.includes(key)) {
      return;
    }

    const next = new Set(modifiers.additive ? this._keys : []);
    if (modifiers.range) {
      // A collapsed or removed anchor cannot define a range in the visible list.
      let anchor = key;
      if (this.anchor !== undefined && visibleKeys.includes(this.anchor)) {
        anchor = this.anchor;
      } else if (this.current !== undefined && visibleKeys.includes(this.current)) {
        anchor = this.current;
      }
      const start = visibleKeys.indexOf(anchor);
      const end = visibleKeys.indexOf(key);
      for (const id of visibleKeys.slice(Math.min(start, end), Math.max(start, end) + 1)) {
        next.add(id);
      }
      this.anchor = anchor;
    } else {
      if (modifiers.additive && next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      this.anchor = key;
    }

    this._keys = next;
    this.current = key;
  }

  selectAll(visibleKeys: readonly string[]) {
    this._keys = new Set(visibleKeys);
  }

  openContext(key: string) {
    if (!this._keys.has(key)) {
      this.replace(key);
    } else {
      this.current = key;
    }
  }

  retain(validKeys: ReadonlySet<string>) {
    const remaining = [...this._keys].filter((key) => validKeys.has(key));
    if (remaining.length !== this._keys.size) {
      this._keys = new Set(remaining);
    }
    if (this.current !== undefined && !validKeys.has(this.current)) {
      this.current = undefined;
    }
    if (this.anchor !== undefined && !validKeys.has(this.anchor)) {
      this.anchor = undefined;
    }
  }

  private _keys: ReadonlySet<string> = new Set();
}
