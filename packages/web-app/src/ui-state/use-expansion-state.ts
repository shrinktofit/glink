import { shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { equalExpansionState, type ExpansionState } from './expansion-state';
import { useExpansionStateStore } from './expansion-state-store';

/** Own a live view's state; persisted snapshots can be evicted without resetting the live view. */
export function useExpansionState(
  key: MaybeRefOrGetter<string | undefined>,
  nodeIds: MaybeRefOrGetter<readonly string[]>,
  ready: MaybeRefOrGetter<boolean>,
  defaultExpanded: MaybeRefOrGetter<boolean> = true,
) {
  const state = shallowRef<ExpansionState>({});
  let previousKey: string | undefined;
  let cache: ReturnType<typeof useExpansionStateStore> | undefined;

  function isExpanded(id: string) {
    return Object.hasOwn(state.value, id) ? state.value[id] : toValue(defaultExpanded);
  }

  watch([
    () => toValue(key),
    () => toValue(nodeIds),
    () => toValue(ready),
  ], ([currentKey, ids, complete]) => {
    if (currentKey !== previousKey) {
      previousKey = currentKey;
      state.value = currentKey
        ? (cache ??= useExpansionStateStore()).read(currentKey) ?? {}
        : {};
    }
    if (!complete) {
      return;
    }
    // Re-capture the current nodes. Deleted nodes disappear without tracking delete/rename events.
    const snapshot = Object.fromEntries(ids.map((id) => [id, isExpanded(id)]));
    if (!equalExpansionState(state.value, snapshot)) {
      state.value = snapshot;
    }
    if (currentKey) {
      cache!.save(currentKey, snapshot);
    }
  }, { immediate: true });

  function setExpanded(ids: readonly string[], expanded: boolean) {
    state.value = { ...state.value, ...Object.fromEntries(ids.map((id) => [id, expanded])) };
    const currentKey = toValue(key);
    if (currentKey && toValue(ready)) {
      cache!.save(currentKey, state.value);
    }
  }

  return { isExpanded, setExpanded };
}
