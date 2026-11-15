import { useStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { equalExpansionState, type ExpansionState } from './expansion-state';

interface SavedExpansionState {
  key: string;
  state: ExpansionState;
}

// Cache view contexts, not filesystem history. A large snapshot cannot consume the whole budget.
const maxViews = 128;
const maxCharacters = 256 * 1024;

export const useExpansionStateStore = defineStore('expansion-state', () => {
  const views = useStorage<SavedExpansionState[]>('glink.expansion-state.v1', [], undefined, {
    shallow: true,
    deep: false,
    writeDefaults: false,
    // Pinia owns live state. Storage events must not pause writes from sibling views in a batch.
    listenToStorageChanges: false,
    serializer: {
      read(raw) {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value) || !value.every((entry) =>
          entry && typeof entry.key === 'string'
          && entry.state && typeof entry.state === 'object' && !Array.isArray(entry.state)
          && Object.values(entry.state).every((expanded) => typeof expanded === 'boolean'),
        )) {
          throw new Error('Invalid Glink expansion-state cache.');
        }
        return value as SavedExpansionState[];
      },
      write: JSON.stringify,
    },
  });

  function read(key: string): ExpansionState | undefined {
    const index = views.value.findIndex((view) => view.key === key);
    if (index < 0) {
      return undefined;
    }
    const entry = views.value[index];
    if (index > 0) {
      views.value = [entry, ...views.value.filter((view) => view.key !== key)];
    }
    return entry.state;
  }

  function remove(key: string) {
    if (views.value.some((view) => view.key === key)) {
      views.value = views.value.filter((view) => view.key !== key);
    }
  }

  function save(key: string, state: ExpansionState) {
    if (!Object.keys(state).length) {
      remove(key);
      return;
    }
    const entry = { key, state };
    if (JSON.stringify([entry]).length > maxCharacters) {
      remove(key);
      return;
    }
    const existing = views.value.find((view) => view.key === key);
    if (existing && equalExpansionState(existing.state, state)) {
      return;
    }
    const next = [entry, ...views.value.filter((view) => view.key !== key)].slice(0, maxViews);
    while (JSON.stringify(next).length > maxCharacters) {
      next.pop();
    }
    views.value = next;
  }

  return {
    views,
    read,
    save,
    remove,
  };
});
