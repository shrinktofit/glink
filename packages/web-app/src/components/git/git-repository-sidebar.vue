<script setup lang="ts">
import { computed, ref } from 'vue';
import type { GitReference, RepositoryOverview } from '@glink/protocol/git';
import FileTree from '../file-tree.vue';
import { GitView } from './git-navigation';

const props = defineProps<{
  overview?: RepositoryOverview;
  repoPath: string;
  changeCount: number;
  busy: boolean;
  error?: string;
  canGoBack: boolean;
}>();
const view = defineModel<GitView>({ required: true });
const emit = defineEmits<{
  refresh: [];
  openRepository: [path: string];
  selectCommit: [sha: string];
  back: [];
}>();
const filter = ref('');
const name = computed(() => props.repoPath.split(/[\\/]/).at(-1));
const query = computed(() => filter.value.toLocaleLowerCase());
const worktrees = computed(() => props.overview?.worktrees.filter((entry) => {
  return `${entry.path} ${entry.branch ?? ''}`.toLocaleLowerCase().includes(query.value);
}) ?? []);
const branches = computed(() => props.overview?.branches.filter((entry) => {
  return entry.name.toLocaleLowerCase().includes(query.value);
}).map((entry) => ({ ...entry, path: entry.name })) ?? []);
const remotes = computed(() => props.overview?.remotes.map((remote) => ({
  ...remote,
  items: remote.branches.filter((entry) => entry.name.toLocaleLowerCase().includes(query.value))
    .map((entry) => ({ ...entry, path: entry.name.slice(remote.name.length + 1) })),
})).filter((remote) => {
  return remote.items.length || remote.name.toLocaleLowerCase().includes(query.value);
}) ?? []);
const tags = computed(() => props.overview?.tags.filter((entry) => {
  return entry.name.toLocaleLowerCase().includes(query.value);
}).map((entry) => ({ ...entry, path: entry.name })) ?? []);
const stashes = computed(() => props.overview?.stashes.filter((entry) => {
  return `${entry.name} ${entry.subject}`.toLocaleLowerCase().includes(query.value);
}) ?? []);
const submodules = computed(() => props.overview?.submodules.filter((entry) => {
  return entry.path.toLocaleLowerCase().includes(query.value);
}) ?? []);

function selectReference(reference: GitReference) {
  emit('selectCommit', reference.sha);
}
</script>

<template>
  <aside
    class="repository-sidebar"
    aria-label="Repository navigation"
  >
    <header>
      <button
        v-if="canGoBack"
        class="icon-button"
        aria-label="Back to previous repository"
        @click="emit('back')"
      >
        ‹
      </button>
      <strong :title="repoPath">{{ name }}</strong>
      <button
        class="icon-button"
        aria-label="Refresh repository"
        :disabled="busy"
        @click="emit('refresh')"
      >
        ↻
      </button>
    </header>
    <nav class="views">
      <button
        :class="{ active: view === GitView.localChanges }"
        @click="view = GitView.localChanges"
      >
        <span aria-hidden="true">▤</span> Local Changes <small>{{ changeCount }}</small>
      </button>
      <button
        :class="{ active: view === GitView.history }"
        @click="view = GitView.history"
      >
        <span aria-hidden="true">☷</span> All Commits
      </button>
    </nav>
    <input
      v-model="filter"
      class="filter"
      type="search"
      placeholder="Filter"
      aria-label="Filter repository navigation"
    >
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="sections">
      <details open>
        <summary>Worktrees <small>{{ worktrees.length }}</small></summary>
        <button
          v-for="worktree in worktrees"
          :key="worktree.path"
          class="nav-entry"
          :class="{ current: worktree.current }"
          :title="worktree.path"
          :disabled="busy || worktree.prunable || worktree.bare"
          @click="emit('openRepository', worktree.path)"
        >
          <span
            class="glyph"
            aria-hidden="true"
          >▱</span>
          <span class="entry-name">
            {{ worktree.path.split('/').at(-1) }}
            <span class="secondary">({{ worktree.branch ?? worktree.head?.slice(0, 8) }})</span>
          </span>
          <span
            v-if="worktree.current"
            aria-label="Current worktree"
          >✓</span>
          <span
            v-else-if="worktree.locked"
            title="Locked"
          >⌑</span>
        </button>
      </details>
      <details open>
        <summary>Branches <small>{{ branches.length }}</small></summary>
        <file-tree
          :items="branches"
          :compact-folders="false"
          aria-label="Branches"
          @select="selectReference"
        >
          <template #prefix="{ item }">
            <span
              class="glyph"
              :class="{ current: item.current }"
            >{{ item.current ? '✓' : '⑂' }}</span>
          </template>
        </file-tree>
      </details>
      <details open>
        <summary>Remotes <small>{{ remotes.length }}</small></summary>
        <details
          v-for="remote in remotes"
          :key="remote.name"
          class="remote"
        >
          <summary :title="remote.fetchUrl">
            {{ remote.name }}
          </summary>
          <file-tree
            :items="remote.items"
            :compact-folders="false"
            :aria-label="`${remote.name} branches`"
            @select="selectReference"
          >
            <template #prefix>
              <span class="glyph">⑂</span>
            </template>
          </file-tree>
        </details>
      </details>
      <details>
        <summary>Tags <small>{{ tags.length }}</small></summary>
        <file-tree
          :items="tags"
          :compact-folders="false"
          aria-label="Tags"
          @select="selectReference"
        >
          <template #prefix>
            <span class="glyph">◇</span>
          </template>
        </file-tree>
      </details>
      <details open>
        <summary>Stashes <small>{{ stashes.length }}</small></summary>
        <button
          v-for="stash in stashes"
          :key="stash.name"
          class="nav-entry"
          :title="`${stash.name}: ${stash.subject}`"
          @click="emit('selectCommit', stash.sha)"
        >
          <span class="glyph">▤</span><span class="entry-name">{{ stash.subject }}</span>
        </button>
      </details>
      <details>
        <summary>Submodules <small>{{ submodules.length }}</small></summary>
        <button
          v-for="submodule in submodules"
          :key="submodule.path"
          class="nav-entry"
          :title="submodule.path"
          :disabled="busy || !submodule.initialized"
          @click="emit('openRepository', `${repoPath}/${submodule.path}`)"
        >
          <span class="glyph">▱</span><span class="entry-name">{{ submodule.path }}</span>
        </button>
      </details>
    </div>
  </aside>
</template>

<style scoped lang="less">
.repository-sidebar { display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--sidebar);
  font-size: .8125rem;
  }
header { display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 2.2em;
  padding: 0 .7em;
  }
header strong { min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  }
.views { padding: 0 .3em .4em; border-bottom: 1px solid var(--divider); }
.views button { display: flex;
  align-items: center;
  gap: .5em;
  width: 100%;
  min-height: 1.8em;
  padding: 0 .7em;
  border-radius: .2em;
  text-align: left;
  }
.active { background: var(--selected); }
.filter { margin: .5em;
  min-width: 0;
  padding: .3em .5em;
  background: var(--surface);
  border: 1px solid var(--divider);
  border-radius: .2em;
  font: inherit;
  }
.sections { flex: 1; min-height: 0; overflow: auto; padding: 0 .3em 1em; }
summary { cursor: pointer; min-height: 1.8em; line-height: 1.8em; white-space: nowrap; }
small { color: var(--muted); font-size: .85em; margin-left: .4em; }
.remote { padding-left: 1em; }
.nav-entry { display: flex;
  align-items: center;
  gap: .4em;
  width: 100%;
  min-height: 1.8em;
  padding: 0 .5em 0 1.5em;
  text-align: left;
  }
.entry-name { flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  }
.glyph { display: inline-block;
  width: 1em;
  flex-shrink: 0;
  color: var(--muted);
  text-align: center;
  }
.current { font-weight: 600; }
.secondary { font-weight: 400; }
button:hover:not(:disabled) { background: var(--hover); }
button:disabled { opacity: .45; cursor: default; }
.error { padding: .5em; color: var(--error); overflow-wrap: anywhere; }
</style>
