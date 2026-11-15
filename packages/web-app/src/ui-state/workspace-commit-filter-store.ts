import { useStorage } from '@vueuse/core';
import { defineStore } from 'pinia';

type ExcludedProjects = Readonly<Record<string, readonly string[]>>;

export const useWorkspaceCommitFilterStore = defineStore('workspace-commit-filter', () => {
  const excluded = useStorage<ExcludedProjects>('glink.workspace-commit-filter.v1', {}, undefined, {
    shallow: true,
    deep: false,
    writeDefaults: false,
    listenToStorageChanges: false,
    serializer: {
      read(raw) {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || !Object.values(value).every((ids) => Array.isArray(ids)
            && ids.every((id) => typeof id === 'string'))) {
          throw new Error('Invalid Glink workspace commit filter.');
        }
        return value as ExcludedProjects;
      },
      write: JSON.stringify,
    },
  });

  function excludeProjects(workspaceId: string, ids: readonly string[]) {
    const previous = excluded.value[workspaceId] ?? [];
    if (previous.length === ids.length && previous.every((id, index) => id === ids[index])) {
      return;
    }
    const next = { ...excluded.value };
    if (ids.length) {
      next[workspaceId] = ids;
    } else {
      delete next[workspaceId];
    }
    excluded.value = next;
  }

  function pruneProjects(workspaceId: string, projectIds: readonly string[]) {
    const existing = new Set(projectIds);
    excludeProjects(
      workspaceId,
      (excluded.value[workspaceId] ?? []).filter((id) => existing.has(id)),
    );
  }

  function pruneWorkspaces(workspaceIds: readonly string[]) {
    const existing = new Set(workspaceIds);
    const entries = Object.entries(excluded.value);
    const retained = entries.filter(([id]) => existing.has(id));
    if (retained.length !== entries.length) {
      excluded.value = Object.fromEntries(retained);
    }
  }

  return {
    excluded,
    excludeProjects,
    pruneProjects,
    pruneWorkspaces,
  };
});
