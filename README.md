# Glink

A web-based workspace for connected repositories and coordinated version control.
Git is the first version control system targeted by the product.

## Requirements

- Node.js 26 or newer
- pnpm 10.33.0 (pinned in `package.json`)

## Development

```sh
pnpm install
node --run dev
```

Open http://127.0.0.1:4311. The local API listens at http://127.0.0.1:4310.
Vite proxies `/api` to the local server. The starter page displays a worktree panel
for `U:\Repos\codex-worktrees\helix-next\vortex`, currently configured in
`packages/web-app/src/app.ts`. The layout follows a desktop Git client:

- A persistent left sidebar shows worktrees, branches, remotes, tags, stashes, and
  immediate submodules from the local repository. Worktrees and initialized submodules
  can be opened; the back button returns to the previous working copy. Unavailable
  worktrees and uninitialized submodules remain visible but cannot be opened.
- All Commits shows the graph above a detail area with Commit and Changes tabs.
  Changes contains a file tree beside its diff. Branches, remote refs, tags, and stashes
  in the sidebar locate the corresponding commit; they do not check out a branch.
- Local Changes shows unstaged/staged trees in a middle column, the selected diff on
  the right, and a commit form below the diff. Switching views preserves the draft.

Split lines can be dragged or resized with the keyboard. The interface uses a compact
light theme. Merge commits compare against their first parent.
File actions stage or unstage one file. Commit uses only the index, and Amend
replaces HEAD. The graph's `maxCommits` prop defaults to 500 and
cannot request more than 500 commits. History includes HEAD, branches, remote
branches, and tags; internal tool refs are excluded.

Turbo builds package dependencies before starting the development processes and
restarts dependent tasks when their inputs change. The server uses Node's native
TypeScript execution and watch mode; use erasable TypeScript syntax in its source.

## Packages

- `@glink/workflow`: shared TypeScript configuration.
- `@glink/web-app`: Vue 3 application with TypeScript SFCs (`<script setup lang="ts">`),
  Less styles, and Vuetify, served and built with Vite. Vue component filenames use
  lowercase kebab-case, for example `glink-app.vue`.
- `@glink/server`: local Node.js HTTP API; owns filesystem and Git integration.
- `@glink/protocol`: browser-safe request and response contracts shared by both apps.

All packages live under `packages/`. Shared dependency versions are maintained in
the pnpm catalog. Library outputs go to `lib/`, and the web build goes to `dist/`.

## Checks and builds

```sh
node --run build
node --run typecheck
node --run lint
node --run test
```

After building, start the compiled API with:

```sh
cd packages/server
node --run start
```

The web build is static output in `packages/web-app/dist/`. Production hosting and
API routing are not configured yet. Workspace management and push are future features.

## UI components

- `file-tree.vue`: accepts `items` with repository-relative, `/`-separated `path`
  values, supports directory expansion and keyboard navigation, and emits `select`.
  `v-model` holds the selected path. The `prefix` and `actions` slots receive the item.
  `compactFolders` defaults to `true`: single-child directory chains display as one
  row, such as `a/b/c`, with files nested below. Set it to `false` for separate rows.
- `diff-tree.vue`: extends the file tree with Git change markers and an actions slot.
- `diff-view.vue`: a read-only Monaco diff editor accepting `original` and `modified`
  text, plus an optional `language`. It updates with its props and disposes its models
  when unmounted. The worktree panel loads it only when opening a diff.
- `git-commit-form.vue`: summary, description, Commit and Amend; exposes model bindings
  and emits `submit`. It does not call Git directly.
- `split-pane.vue`: shared horizontal/vertical split layout with pointer and keyboard resizing.
- `git-worktree-panel.vue`: owns repository navigation and creates the selected repository service.
- `git-repository-view.vue`: provides that service to its subtree and coordinates refreshes,
  view selection, local diffs, index operations, and commits.
- `git-repository-sidebar.vue`: repository inventory, filtering, view and reference navigation.
- `git-history-view.vue`: graph above `commit-detail-view.vue`.
- `commit-detail-view.vue`: loads a selected commit and arranges Commit/Changes tabs;
  the Changes tab owns its file selection and historical diff.
- `git-commit-info.vue`: full commit metadata or the compact information strip.
- `git-local-changes-view.vue`: two change lists beside the diff and commit form.
- `git-change-list.vue`: one staged/unstaged file list with index actions.
- `git-file-diff.vue`: shared diff header, loading/error state, and lazy Monaco rendering.
