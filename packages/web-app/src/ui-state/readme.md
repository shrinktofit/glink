# Browser-local UI state

Expansion is a disposable browser-local view snapshot, separate from workspace YAML and Git data.

- `expansion-state-store.ts` is the Pinia owner of saved snapshots. VueUse handles localStorage IO;
  one versioned key stores at most 128 view contexts and 256 Ki characters of serialized JSON.
  Reads promote a context in the LRU order. Oversized snapshots are not retained.
- `use-expansion-state.ts` owns each mounted view's live state. It restores on context changes and
  captures all current node IDs, including hidden descendants. A complete collection removes stale
  IDs from the next snapshot. Loading or failed data must not be marked ready.
- The file tree supplies real folder paths, independent of compact row labels. A compact row toggles
  every folder it represents, so splitting or joining rows preserves the user's intent.
- Git changes opt in with a key scoped to worktree path and staged/unstaged area. Repository and
  workspace views of the same worktree share it. Other file trees remain ephemeral.
- Workspace project headers use a separate context per workspace and area, with project IDs as
  nodes. Empty change lists retain the header state while the project exists. Successful empty lists
  explicitly remove the folder snapshot because there is no mounted tree to capture it.

Pinia provides in-app sharing; storage events do not drive live views. Reloading reads the browser's
latest saved cache. Evicting a snapshot never resets an already mounted view. VueUse reports cache
IO errors; the live expansion state does not depend on a successful storage write.

Workspace commit filters are durable preferences in `workspace-commit-filter-store.ts`, independent
of the disposable expansion cache. Pinia and VueUse store excluded project IDs under
`glink.workspace-commit-filter.v1`, scoped by workspace ID. No exclusion means selected, so new
projects default to selected and an explicitly empty selection survives reload. Complete workspace
documents prune removed projects; successful catalog reads prune removed workspaces. Renames retain
the same IDs and preferences. Outline browsing selection does not change this filter.
