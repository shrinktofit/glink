<script setup lang="ts">
import { computed, inject } from 'vue';
import { GitIndexAction, type GitFileChange } from '@glink/protocol/git';
import DiffTree from '../diff-tree.vue';
import { gitRepoServiceKey } from '../../git/git-repo-service';
import { gitChangesTreeStateKey } from '../../git/git-changes-tree-state-key';
import { GitIndexScope, type GitIndexTarget } from '../../git/git-index-target';

const props = defineProps<{
  items: GitFileChange[];
  staged: boolean;
  selectedPath?: string;
  pendingPath?: string;
  busy: boolean;
  loading: boolean;
  ready: boolean;
}>();
const emit = defineEmits<{
  select: [file: GitFileChange];
  changeIndex: [target: GitIndexTarget, action: GitIndexAction];
}>();
const action = computed(() => props.staged ? GitIndexAction.unstage : GitIndexAction.stage);
const repo = inject(gitRepoServiceKey)!;

function changeIndex(file: GitFileChange) {
  if (!props.busy && !props.loading && (props.staged || !file.stageBlockedReason)) {
    emit('changeIndex', { scope: GitIndexScope.file, path: file.path }, action.value);
  }
}
</script>

<template>
  <section
    class="change-list"
    :aria-label="staged ? 'Staged changes' : 'Unstaged changes'"
    :aria-busy="loading"
  >
    <header>
      <span>{{ staged ? 'Staged' : 'Unstaged' }} <small>{{ items.length }}</small></span>
    </header>
    <div class="tree-scroll">
      <diff-tree
        :items="items"
        :repo-path="repo.repoPath"
        :state-key="gitChangesTreeStateKey(repo.repoPath, staged)"
        :data-ready="ready"
        :model-value="selectedPath"
        :disabled-paths="pendingPath ? [pendingPath] : undefined"
        :index-action="action"
        :index-disabled="busy || loading"
        @select="emit('select', $event)"
        @activate="changeIndex"
        @index-directory="
          emit('changeIndex', { scope: GitIndexScope.directory, path: $event }, action)
        "
      >
        <template #actions="{ item }">
          <button
            class="file-action"
            :aria-label="`${staged ? 'Unstage' : 'Stage'} ${item.path}`"
            :title="staged ? 'Unstage' : item.stageBlockedReason ?? 'Stage'"
            :disabled="busy || loading || (!staged && !!item.stageBlockedReason)"
            @click="changeIndex(item)"
          >
            {{ staged ? '−' : '+' }}
          </button>
        </template>
      </diff-tree>
    </div>
  </section>
</template>

<style scoped lang="less">
.change-list { display: flex; flex-direction: column; height: 100%; min-height: 0; }
header { flex-shrink: 0;
  padding: .35em .65em;
  font-size: .8125rem;
  background: var(--sidebar);
  border-bottom: 1px solid var(--divider);
  }
small { color: var(--muted); margin-left: .4em; }
.tree-scroll { flex: 1; min-height: 0; overflow: auto; }
.file-action { flex-shrink: 0;
  width: 1.5em;
  height: 1.6em;
  color: var(--muted);
  font-size: .875rem;
  }
.file-action:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.file-action:disabled { opacity: .4; }
</style>
