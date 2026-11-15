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
import { GitIndexScope, type GitIndexTarget } from '../../git/git-index-target';
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
const status = ref<WorktreeStatus>({ staged: [], unstaged: [], indexFingerprint: 'unavailable' });
const statusReady = ref(false);
const loading = ref(true);
const busy = ref(false);
const pendingIndexPath = ref<string>();
const error = ref('');
const overviewError = ref('');
const refreshKey = ref(0);
const historyRefreshKey = ref(0);
const selectedCommit = ref<string>();
const selectedFile = ref<{ file: GitFileChange; staged: boolean }>();
const diff = ref<FileDiffResponse>();
const diffError = ref('');
const summary = ref('');
const description = ref('');
const amend = ref(false);
const lifecycle = new AbortController();
let controller: AbortController | undefined;
let metadataController: AbortController | undefined;
let metadataDirty = false;
let overviewDirty = false;

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

function applyStatus(state: WorktreeStatus) {
  status.value = state;
  statusReady.value = true;
  const selected = selectedFile.value;
  if (selected) {
    const files = selected.staged ? state.staged : state.unstaged;
    if (!files.some((file) => file.path === selected.file.path)) {
      selectedFile.value = undefined;
    }
  }
  refreshKey.value++;
}

async function refreshMetadata() {
  const request = new AbortController();
  metadataController = request;
  try {
    const [state, repository] = await Promise.all([
      metadataDirty ? repo.getWorktreeStatus(request.signal) : undefined,
      repo.getRepositoryOverview(request.signal),
    ]);
    if (!request.signal.aborted) {
      if (state) {
        applyStatus(state);
        metadataDirty = false;
      }
      overview.value = repository;
      overviewDirty = false;
    }
  } catch (cause: unknown) {
    if (!request.signal.aborted) {
      overviewError.value = String(cause);
    }
  }
}

async function refresh() {
  metadataController?.abort();
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
    applyStatus(worktreeResult.value);
    metadataDirty = false;
  } else {
    error.value = String(worktreeResult.reason);
  }
  if (overviewResult.status === 'fulfilled') {
    overview.value = overviewResult.value;
    overviewDirty = false;
  } else {
    overviewError.value = String(overviewResult.reason);
  }
  loading.value = false;
  historyRefreshKey.value++;
}

async function changeIndex(target: GitIndexTarget, action: GitIndexAction) {
  if (busy.value || loading.value) {
    return;
  }
  busy.value = true;
  metadataController?.abort();
  pendingIndexPath.value = target.scope === GitIndexScope.worktree ? undefined : target.path;
  error.value = '';
  try {
    const state = target.scope === GitIndexScope.file
      ? await repo.changeIndex(target.path, action)
      : await repo.changeAllIndex(action,
        target.scope === GitIndexScope.directory ? target.path : undefined);
    if (lifecycle.signal.aborted) {
      return;
    }
    const headChanged = status.value.head !== state.head;
    metadataDirty ||= headChanged;
    overviewDirty ||= headChanged || !!state.submodulePaths
      || status.value.branch !== state.branch;
    applyStatus({ ...state, headMessage: headChanged ? undefined : status.value.headMessage });
    if (headChanged) {
      historyRefreshKey.value++;
    }
    if (metadataDirty || overviewDirty) {
      void refreshMetadata();
    }
  } catch (cause: unknown) {
    if (lifecycle.signal.aborted) {
      return;
    }
    error.value = cause instanceof Error ? cause.message : String(cause);
    try {
      applyStatus(await repo.getWorktreeStatus(lifecycle.signal));
      metadataDirty = false;
    } catch (refreshError: unknown) {
      error.value += `\n工作树状态刷新失败：${String(refreshError)}`;
      statusReady.value = false;
    }
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
    if (lifecycle.signal.aborted) {
      return;
    }
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

watch([selectedFile, refreshKey, busy], async ([selected], [previous]) => {
  if (selected?.file.path !== previous?.file.path || selected?.staged !== previous?.staged) {
    diff.value = undefined;
  }
  diffError.value = '';
  if (!selected || busy.value) {
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

function selectFile(file: GitFileChange, staged: boolean) {
  if (selectedFile.value?.file.path === file.path && selectedFile.value.staged === staged) {
    return;
  }
  selectedFile.value = { file, staged };
}

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
  lifecycle.abort();
  metadataController?.abort();
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
        :refresh-key="historyRefreshKey"
        :references="references"
      />
      <git-local-changes-view
        v-show="view === GitView.localChanges"
        v-model:summary="summary"
        v-model:description="description"
        v-model:amend="amend"
        :status="status"
        :status-ready="statusReady"
        :selected="selectedFile"
        :pending-path="pendingIndexPath"
        :diff="diff"
        :diff-error="diffError"
        :error="error"
        :busy="busy"
        :loading="loading"
        @select="selectFile"
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
