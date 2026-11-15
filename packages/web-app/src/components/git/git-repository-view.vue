<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch, onWatcherCleanup } from 'vue';
import type {
  FileDiffResponse,
  GitCommitInput,
  GitFileChange,
  GitIndexAction,
  RepositoryOverview,
  WorktreeStatus,
} from '@glink/protocol/git';
import { GitRepoService, gitRepoServiceKey } from '../../git/git-repo-service';
import SplitPane from '../split-pane.vue';
import GitHistoryView from './git-history-view.vue';
import GitLocalChangesView from './git-local-changes-view.vue';
import GitRepositorySidebar from './git-repository-sidebar.vue';
import { GitView } from './git-navigation';

const props = defineProps<{ repo: GitRepoService; canGoBack: boolean }>();
const emit = defineEmits<{ openRepository: [path: string]; back: [] }>();
const repo = props.repo;
provide(gitRepoServiceKey, repo);

const view = ref(GitView.history);
const sidebarWidth = ref(0.15);
const overview = ref<RepositoryOverview>();
const status = ref<WorktreeStatus>({ staged: [], unstaged: [] });
const loading = ref(true);
const busy = ref(false);
const pendingIndexPath = ref<string>();
const error = ref('');
const overviewError = ref('');
const refreshKey = ref(0);
const selectedCommit = ref<string>();
const selectedFile = ref<{ file: GitFileChange; staged: boolean }>();
const diff = ref<FileDiffResponse>();
const diffError = ref('');
const summary = ref('');
const description = ref('');
const amend = ref(false);
let controller: AbortController | undefined;

const changeCount = computed(() => new Set([
  ...status.value.staged.map((file) => file.path),
  ...status.value.unstaged.map((file) => file.path),
]).size);
const references = computed(() => overview.value
  ? [
    ...overview.value.branches,
    ...overview.value.tags,
    ...overview.value.remotes.flatMap((remote) => remote.branches),
  ]
  : []);

async function refresh() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  loading.value = true;
  overviewError.value = '';
  const results = await Promise.allSettled([
    repo.getWorktreeStatus(request.signal),
    repo.getRepositoryOverview(request.signal),
  ]);
  if (request.signal.aborted) {
    return;
  }
  const [worktreeResult, overviewResult] = results;
  if (worktreeResult.status === 'fulfilled') {
    status.value = worktreeResult.value;
    const selected = selectedFile.value;
    if (selected) {
      const files = selected.staged ? status.value.staged : status.value.unstaged;
      if (!files.some((file) => file.path === selected.file.path)) {
        selectedFile.value = undefined;
      }
    }
  } else {
    error.value = String(worktreeResult.reason);
  }
  if (overviewResult.status === 'fulfilled') {
    overview.value = overviewResult.value;
  } else {
    overviewError.value = String(overviewResult.reason);
  }
  loading.value = false;
  refreshKey.value++;
}

async function changeIndex(file: GitFileChange, action: GitIndexAction) {
  if (busy.value || loading.value) {
    return;
  }
  busy.value = true;
  pendingIndexPath.value = file.path;
  error.value = '';
  try {
    await repo.changeIndex(file.path, action);
    await refresh();
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    pendingIndexPath.value = undefined;
    busy.value = false;
  }
}

async function commit(input: GitCommitInput) {
  busy.value = true;
  error.value = '';
  try {
    await repo.commit(input);
    summary.value = '';
    description.value = '';
    amend.value = false;
    await refresh();
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

watch([selectedFile, refreshKey], async ([selected], [previous]) => {
  if (selected?.file.path !== previous?.file.path || selected?.staged !== previous?.staged) {
    diff.value = undefined;
  }
  diffError.value = '';
  if (!selected) {
    return;
  }
  const request = new AbortController();
  onWatcherCleanup(() => request.abort());
  try {
    const result = await repo.getFileDiff(selected.file.path, selected.staged, request.signal);
    if (!request.signal.aborted) {
      diff.value = result;
    }
  } catch (cause: unknown) {
    if (!request.signal.aborted) {
      diffError.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
});

function selectCommit(sha: string) {
  selectedCommit.value = sha;
  view.value = GitView.history;
}

function refreshOnFocus() {
  if (!busy.value) {
    void refresh();
  }
}

onMounted(() => {
  void refresh();
  window.addEventListener('focus', refreshOnFocus);
});
onBeforeUnmount(() => {
  controller?.abort();
  window.removeEventListener('focus', refreshOnFocus);
});
</script>

<template>
  <split-pane
    v-model="sidebarWidth"
    class="repository-view"
    :min="0.1"
    :max="0.35"
  >
    <template #first>
      <git-repository-sidebar
        v-model="view"
        :overview="overview"
        :repo-path="repo.repoPath"
        :change-count="changeCount"
        :busy="busy || loading"
        :error="overviewError"
        :can-go-back="canGoBack"
        @refresh="refresh"
        @open-repository="emit('openRepository', $event)"
        @back="emit('back')"
        @select-commit="selectCommit"
      />
    </template>
    <template #second>
      <git-history-view
        v-show="view === GitView.history"
        v-model="selectedCommit"
        :refresh-key="refreshKey"
        :references="references"
      />
      <git-local-changes-view
        v-show="view === GitView.localChanges"
        v-model:summary="summary"
        v-model:description="description"
        v-model:amend="amend"
        :status="status"
        :selected="selectedFile"
        :pending-path="pendingIndexPath"
        :diff="diff"
        :diff-error="diffError"
        :error="error"
        :busy="busy"
        :loading="loading"
        @select="(file, staged) => selectedFile = { file, staged }"
        @close="selectedFile = undefined"
        @change-index="changeIndex"
        @commit="commit"
      />
    </template>
  </split-pane>
</template>

<style scoped lang="less">
.repository-view { height: 100dvh;
  min-height: 30em;
  color: var(--text);
  background: var(--surface);
  }
</style>
