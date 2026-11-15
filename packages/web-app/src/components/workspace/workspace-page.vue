<script setup lang="ts">
import {
  computed,
  inject,
  onMounted,
  onUnmounted,
  onWatcherCleanup,
  ref,
  useTemplateRef,
  watch,
} from 'vue';
import { GitIndexAction, type FileDiffResponse, type GitFileChange } from '@glink/protocol/git';
import type {
  WorkspaceCommit,
  WorkspaceCommitResult,
  WorkspaceDocument,
  WorkspaceProjectStatus,
  WorkspaceChangesSnapshot,
} from '@glink/protocol/workspace';
import { WorkspaceConnectionKind } from '@glink/protocol/workspace';
import { appKey } from '../../app-context';
import { GitIndexScope, type GitIndexTarget } from '../../git/git-index-target';
import GitFileDiff from '../git/git-file-diff.vue';
import SplitPane from '../split-pane.vue';
import WorkspaceOutline from './workspace-outline.vue';
import WorkspaceProjectGraph from './workspace-project-graph.vue';
import WorkspaceChangeList from './workspace-change-list.vue';
import WorkspaceCommitForm from './workspace-commit-form.vue';
import WorkspaceCommitDetail from './workspace-commit-detail.vue';
import WorkspaceHistory from './workspace-history.vue';
const workspace = defineModel<WorkspaceDocument>({ required: true });
const app = inject(appKey)!;
const service = app.workspaceService;
enum WorkspaceTab {
  local = 'local',
  history = 'history',
}
const tab = ref(WorkspaceTab.local);
const statuses = ref<WorkspaceProjectStatus[]>([]);
const statusesReady = computed(() => workspace.value.projects.every((project) =>
  statuses.value.some((status) => status.projectId === project.id),
));
const commits = ref<WorkspaceCommit[]>([]);
const historyErrors = ref<Array<{ projectId: string; error: string }>>([]);
const historyLoading = ref(false);
const historyError = ref('');
// Outline selection defines browsing scope independently of file and commit focus.
const selectedProjectIds = ref(workspace.value.projects.slice(0, 1).map((project) => project.id));
const projectSelectionAnchor = ref(selectedProjectIds.value[0]);
const projectIds = computed(() => workspace.value.projects.map((project) => project.id));
const selectedProjectSet = computed(() => new Set(selectedProjectIds.value));
const grouped = computed(() => selectedProjectIds.value.length > 1);
const scopeName = computed(() => {
  if (!selectedProjectIds.value.length) {
    return 'No projects selected';
  }
  if (!grouped.value) {
    return workspace.value.projects.find(
      (project) => selectedProjectSet.value.has(project.id),
    )?.name;
  }
  return selectedProjectIds.value.length === workspace.value.projects.length
    ? 'All projects'
    : `${selectedProjectIds.value.length} projects`;
});
const visibleCommits = computed(() =>
  commits.value.filter((commit) => selectedProjectSet.value.has(commit.projectId)),
);
const visibleHistoryErrors = computed(() =>
  historyErrors.value.filter((entry) => selectedProjectSet.value.has(entry.projectId)),
);
const expanded = ref(false);
const busy = ref(false);
// An absent path represents a pending batch for the whole project.
const pendingIndex = ref<{ projectId: string; path?: string }>();
const loading = ref(false);
const refreshKey = ref(0);
const historyRefreshKey = ref(0);
const error = ref('');
const diffError = ref('');
const selection = ref<{ projectId: string; path: string; staged: boolean }>();
const diff = ref<FileDiffResponse>();
const diffTitle = computed(() => {
  const project = workspace.value.projects.find((item) => item.id === selection.value?.projectId);
  return selection.value
    ? grouped.value ? `${project?.name} / ${selection.value.path}` : selection.value.path
    : undefined;
});
const selectedCommit = ref<WorkspaceCommit>();
const commitProject = computed(() =>
  workspace.value.projects.find((project) => project.id === selectedCommit.value?.projectId),
);
const result = ref<WorkspaceCommitResult>();
const outline = useTemplateRef('outline');
const commitForm = useTemplateRef('commit-form');
const columns = ref(0.32);
const rows = ref(0.43);
const changeRows = ref(0.54);
let refreshController: AbortController | undefined;
let relatedStatusController: AbortController | undefined;
// A newer index mutation cancels reads, but must retain their unfinished invalidations.
const pendingStatusIds = new Set<string>();
const staleMetadataIds = new Set<string>();
let structureDirty = false;

watch(projectIds, (ids, previous) => {
  const remaining = selectedProjectIds.value.filter((id) => ids.includes(id));
  if (remaining.length !== selectedProjectIds.value.length) {
    selectedProjectIds.value = remaining.length ? remaining : ids.slice(0, 1);
  } else if (!previous.length && ids.length && !remaining.length) {
    selectedProjectIds.value = ids.slice(0, 1);
  }
  if (!ids.includes(projectSelectionAnchor.value)) {
    projectSelectionAnchor.value = selectedProjectIds.value[0];
  }
});

function selectProject(id: string, event: MouseEvent) {
  const ids = projectIds.value;
  let next = new Set(selectedProjectIds.value);
  const additive = event.ctrlKey || event.metaKey;
  if (event.shiftKey) {
    const start = ids.indexOf(projectSelectionAnchor.value ?? id);
    const end = ids.indexOf(id);
    if (!additive) {
      next.clear();
    }
    for (const projectId of ids.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      next.add(projectId);
    }
    projectSelectionAnchor.value ??= id;
  } else {
    if (additive) {
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
    } else {
      next = new Set([id]);
    }
    projectSelectionAnchor.value = id;
  }
  const selected = ids.filter((projectId) => next.has(projectId));
  if (selected.length !== selectedProjectIds.value.length
    || selected.some((projectId, index) => projectId !== selectedProjectIds.value[index])) {
    selectedProjectIds.value = selected;
  }
}

watch(selectedProjectSet, (ids) => {
  if (selection.value && !ids.has(selection.value.projectId)) {
    selection.value = undefined;
  }
});

watch(visibleCommits, (commits) => {
  if (!commits.some((commit) => commit.projectId === selectedCommit.value?.projectId
    && commit.sha === selectedCommit.value.sha)) {
    selectedCommit.value = commits[0];
  }
});

watch([selectedProjectIds, historyRefreshKey], async ([ids]) => {
  const controller = new AbortController();
  onWatcherCleanup(() => controller.abort());
  historyError.value = '';
  if (!ids.length) {
    commits.value = [];
    historyErrors.value = [];
    historyLoading.value = false;
    return;
  }
  historyLoading.value = true;
  try {
    const history = await service.history(workspace.value.id, ids, controller.signal);
    if (!controller.signal.aborted) {
      commits.value = history.commits;
      historyErrors.value = history.errors;
    }
  } catch (cause: unknown) {
    if (!controller.signal.aborted) {
      historyError.value = String(cause);
    }
  } finally {
    if (!controller.signal.aborted) {
      historyLoading.value = false;
    }
  }
}, { immediate: true });

function applyStatuses(updates: WorkspaceProjectStatus[], metadataFresh = true) {
  const states = new Map(statuses.value.map((status) => [status.projectId, status]));
  for (const status of updates) {
    if (metadataFresh && !status.error) {
      staleMetadataIds.delete(status.projectId);
    }
    states.set(status.projectId, status);
  }
  statuses.value = workspace.value.projects.flatMap((project) => {
    const status = states.get(project.id);
    return status ? [status] : [];
  });
  const selected = selection.value;
  const current = updates.find((status) => status.projectId === selected?.projectId);
  if (selected && current) {
    if (!(selected.staged ? current.staged : current.unstaged)
      .some((file) => file.path === selected.path)) {
      selection.value = undefined;
    }
    refreshKey.value++;
  }
}

async function refreshRelatedStatuses(state: WorkspaceChangesSnapshot, metadataStale: boolean) {
  const projectId = state.projectId;
  const project = workspace.value.projects.find((project) => project.id === projectId)!;
  const registeredPaths = new Set(workspace.value.connections
    .filter((connection) => connection.kind === WorkspaceConnectionKind.submodule
      && connection.from === projectId)
    .map((connection) => workspace.value.projects.find((child) => child.id === connection.to)!
      .worktreePath.slice(project.worktreePath.length + 1)));
  if (state.submodulePaths && (registeredPaths.size !== state.submodulePaths.length
    || state.submodulePaths.some((path) => !registeredPaths.has(path)))) {
    structureDirty = true;
  }
  const related = new Set([projectId]);
  let count: number;
  do {
    count = related.size;
    for (const connection of workspace.value.connections) {
      if (connection.kind === WorkspaceConnectionKind.submodule && related.has(connection.to)) {
        related.add(connection.from);
      }
    }
  } while (related.size !== count);
  for (const id of related) {
    pendingStatusIds.add(id);
  }
  if (!metadataStale) {
    pendingStatusIds.delete(projectId);
  }
  if (!pendingStatusIds.size && !structureDirty) {
    return;
  }
  const controller = new AbortController();
  relatedStatusController = controller;
  try {
    // Use the fetched snapshot here; v-model prop updates may arrive on the next render.
    let document = workspace.value;
    if (structureDirty) {
      document = await service.get(document.id, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      workspace.value = document;
      structureDirty = false;
      const knownIds = new Set(statuses.value.map((status) => status.projectId));
      for (const project of document.projects) {
        if (!knownIds.has(project.id)) {
          pendingStatusIds.add(project.id);
        }
      }
    }
    const ids = [...pendingStatusIds].filter((id) =>
      document.projects.some((project) => project.id === id),
    );
    if (!ids.length) {
      return;
    }
    const states = await service.status(workspace.value.id, {
      projectIds: ids,
      signal: controller.signal,
    });
    if (!controller.signal.aborted) {
      applyStatuses(states);
      for (const id of ids) {
        pendingStatusIds.delete(id);
      }
    }
  } catch (cause: unknown) {
    if (!controller.signal.aborted) {
      error.value = `关联项目状态刷新失败：${String(cause)}`;
    }
  }
}

async function refresh() {
  relatedStatusController?.abort();
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  loading.value = true;
  error.value = '';
  try {
    const document = await service.get(workspace.value.id);
    if (controller.signal.aborted) {
      return;
    }
    workspace.value = document;
    const state = await service.status(workspace.value.id, { signal: controller.signal });
    if (controller.signal.aborted) {
      return;
    }
    applyStatuses(state);
    pendingStatusIds.clear();
    structureDirty = false;
    historyRefreshKey.value++;
  } catch (cause: unknown) {
    if (!controller.signal.aborted) {
      error.value = String(cause);
    }
  } finally {
    if (!controller.signal.aborted) {
      loading.value = false;
    }
  }
}

const diffPending = computed(() => busy.value && (!pendingIndex.value
  || pendingIndex.value.projectId === selection.value?.projectId));

watch([selection, refreshKey, diffPending], async ([selected], [previous]) => {
  if (
    selected?.projectId !== previous?.projectId
    || selected?.path !== previous?.path
    || selected?.staged !== previous?.staged
  ) {
    diff.value = undefined;
  }
  diffError.value = '';
  if (!selected || diffPending.value) {
    return;
  }
  const controller = new AbortController();
  onWatcherCleanup(() => controller.abort());
  try {
    const value = await service.diff(
      workspace.value.id,
      selected.projectId,
      selected.path,
      selected.staged,
      controller.signal,
    );
    if (!controller.signal.aborted) {
      diff.value = value;
    }
  } catch (cause: unknown) {
    if (!controller.signal.aborted) {
      diffError.value = String(cause);
    }
  }
});

async function changed(document: WorkspaceDocument) {
  workspace.value = document;
  await refresh();
}

function selectFile(projectId: string, file: GitFileChange, staged: boolean) {
  if (selection.value?.projectId === projectId && selection.value.path === file.path
    && selection.value.staged === staged) {
    return;
  }
  selection.value = { projectId, path: file.path, staged };
}

async function index(projectId: string, staged: boolean, target: GitIndexTarget) {
  if (busy.value || loading.value) {
    return;
  }
  busy.value = true;
  relatedStatusController?.abort();
  pendingIndex.value = {
    projectId,
    path: target.scope === GitIndexScope.worktree ? undefined : target.path,
  };
  error.value = '';
  result.value = undefined;
  try {
    const action = staged ? GitIndexAction.unstage : GitIndexAction.stage;
    const state = target.scope === GitIndexScope.file
      ? await service.changeIndex(workspace.value.id, projectId, target.path, action)
      : await service.changeAllIndex(
        workspace.value.id,
        projectId,
        action,
        target.scope === GitIndexScope.directory ? target.path : undefined,
      );
    if (!focusController.signal.aborted) {
      const previous = statuses.value.find((status) => status.projectId === state.projectId);
      const metadataStale = !previous || !!previous.error || staleMetadataIds.has(state.projectId)
        || previous.head !== state.head
        || previous.baseCommit !== state.baseCommit;
      if (metadataStale) {
        staleMetadataIds.add(state.projectId);
      }
      const baseAmendBlockedReason = metadataStale
        ? '等待有效的项目状态。'
        : previous.baseAmendBlockedReason;
      applyStatuses([{
        ...state,
        headMessage: metadataStale ? undefined : previous.headMessage,
        aheadCount: metadataStale ? undefined : previous.aheadCount,
        baseAmendBlockedReason,
        amendBlockedReason: baseAmendBlockedReason ?? state.amendBlockedReason,
        submodulePaths: state.submodulePaths ?? previous?.submodulePaths,
      }], false);
      if (previous?.head !== state.head) {
        historyRefreshKey.value++;
      }
      void refreshRelatedStatuses(state, metadataStale);
    }
  } catch (cause: unknown) {
    error.value = String(cause);
    try {
      applyStatuses(await service.status(workspace.value.id, {
        projectIds: [projectId],
        signal: focusController.signal,
      }));
    } catch (refreshError: unknown) {
      if (!focusController.signal.aborted) {
        applyStatuses([{
          projectId,
          staged: [],
          unstaged: [],
          indexFingerprint: 'unavailable',
          error: String(refreshError),
        }]);
        error.value += `\n目标项目状态刷新失败：${String(refreshError)}`;
      }
    }
  } finally {
    pendingIndex.value = undefined;
    busy.value = false;
  }
}

async function commit(projectIds: string[], message: string, amend: boolean) {
  busy.value = true;
  error.value = '';
  result.value = undefined;
  try {
    result.value = await service.commit(workspace.value.id, {
      projectIds,
      message,
      amend,
      expected: statuses.value.map((status) => ({
        projectId: status.projectId,
        head: status.head,
        baseCommit: status.baseCommit,
        indexFingerprint: status.indexFingerprint,
      })),
    });
    if (!result.value.failed) {
      commitForm.value!.clear();
    }
    await refresh();
  } catch (cause: unknown) {
    await refresh();
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}

const focusController = new AbortController();
onMounted(() => {
  void refresh();
  window.addEventListener(
    'focus',
    () => {
      if (!busy.value) {
        void refresh();
      }
    },
    { signal: focusController.signal },
  );
});
onUnmounted(() => {
  refreshController?.abort();
  relatedStatusController?.abort();
  focusController.abort();
});
</script>
<template>
  <main
    class="workspace-page"
    :class="{ expanded }"
  >
    <workspace-outline
      ref="outline"
      v-model:expanded="expanded"
      :selected="selectedProjectIds"
      :workspace="workspace"
      :statuses="statuses"
      :service="service"
      :busy="busy"
      @select="selectProject"
      @changed="changed"
    />
    <section class="workarea ws-panel">
      <header class="mainbar">
        <button
          :class="{ active: tab === WorkspaceTab.local }"
          @click="tab = WorkspaceTab.local"
        >
          Local Changes
        </button><button
          :class="{ active: tab === WorkspaceTab.history }"
          @click="tab = WorkspaceTab.history"
        >
          All Commits
        </button><span class="scope muted">{{
          tab === WorkspaceTab.local ? scopeName : `${scopeName} · Base → HEAD · 500 max`
        }}</span><button
          class="ws-icon"
          :disabled="busy || loading || historyLoading"
          aria-label="刷新工作区"
          @click="refresh"
        >
          {{ loading || historyLoading ? '…' : '↻' }}
        </button>
      </header>
      <p
        v-if="error"
        class="ws-error"
        role="alert"
      >
        {{ error }}
      </p>
      <div
        v-if="result"
        class="commit-result"
        role="status"
      >
        <span>{{ result.committed.length }} committed · {{ result.skipped.length }} skipped</span>
        <p
          v-if="result.failed"
          class="ws-error"
          role="alert"
        >
          {{
            workspace.projects.find((project) => project.id === result!.failed!.projectId)?.name
          }}: {{ result.failed.error }}
        </p>
        <button
          class="ws-icon"
          aria-label="关闭提交结果"
          @click="result = undefined"
        >
          ×
        </button>
      </div>
      <split-pane
        v-show="tab === WorkspaceTab.local"
        v-model="columns"
        class="workspace-content"
      >
        <template #first>
          <split-pane
            v-model="changeRows"
            vertical
            class="local-lists"
          >
            <template #first>
              <workspace-change-list
                :workspace="workspace"
                :project-ids="selectedProjectIds"
                :statuses="statuses"
                :staged="false"
                :selected="selection"
                :pending-index="pendingIndex"
                :busy="busy"
                :loading="loading"
                @select="(projectId, file) => selectFile(projectId, file, false)"
                @index="(projectId, target) => index(projectId, false, target)"
              />
            </template><template #second>
              <workspace-change-list
                :workspace="workspace"
                :project-ids="selectedProjectIds"
                :statuses="statuses"
                staged
                :selected="selection"
                :pending-index="pendingIndex"
                :busy="busy"
                :loading="loading"
                @select="(projectId, file) => selectFile(projectId, file, true)"
                @index="(projectId, target) => index(projectId, true, target)"
              />
            </template>
          </split-pane>
        </template>
        <template #second>
          <div class="editor-column">
            <div class="diff-area ws-shared">
              <git-file-diff
                v-if="selection"
                :path="diffTitle"
                :diff="diff"
                :error="diffError"
                @close="selection = undefined"
              />
              <div
                v-else
                class="empty-editor"
              >
                <span>◇</span>
                <p>选择文件查看修改</p>
              </div>
            </div>
            <workspace-commit-form
              ref="commit-form"
              :workspace="workspace"
              :statuses="statuses"
              :busy="busy"
              :loading="loading || !statusesReady"
              @submit="commit"
            />
          </div>
        </template>
      </split-pane>
      <template v-if="tab === WorkspaceTab.history">
        <p
          v-if="historyError"
          class="ws-error"
          role="alert"
        >
          {{ historyError }}
        </p>
        <div
          v-if="visibleHistoryErrors.length"
          class="history-errors"
        >
          <details>
            <summary class="muted">
              {{ visibleHistoryErrors.length }} 个 Project 无法读取历史
            </summary>
            <p
              v-for="entry in visibleHistoryErrors"
              :key="entry.projectId"
              class="ws-error"
            >
              {{ workspace.projects.find((project) => project.id === entry.projectId)?.name }}:
              {{ entry.error }}
            </p>
          </details>
        </div>
        <split-pane
          v-model="rows"
          vertical
          class="workspace-content"
        >
          <template #first>
            <workspace-history
              v-model="selectedCommit"
              :workspace="workspace"
              :commits="visibleCommits"
              :show-project-names="grouped"
              :loading="historyLoading"
            />
          </template><template #second>
            <workspace-commit-detail
              v-if="selectedCommit && commitProject"
              :key="commitProject.id"
              :project="commitProject"
              :sha="selectedCommit.sha"
              :git-service="app.gitService"
            />
            <div
              v-else
              class="ws-empty"
            >
              选择一个提交
            </div>
          </template>
        </split-pane>
      </template>
    </section>
    <section
      v-if="expanded"
      class="graph-drawer ws-panel"
    >
      <header>
        <strong>Project Graph</strong>
      </header>
      <workspace-project-graph
        :workspace="workspace"
        :selected="selectedProjectIds"
        :statuses="statuses"
        @select="selectProject"
        @edit="outline!.edit($event)"
      />
    </section>
  </main>
</template>
<style scoped lang="less">
.workspace-page {
  --outline-width: 19em;
  position: relative;
  display: grid;
  grid-template-columns: var(--outline-width) minmax(0, 1fr);
  gap: 0.8em;
  flex: 1;
  min-height: 0;
}
.workarea {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0.7em;
}
.mainbar {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--ws-line);
  flex-shrink: 0;
  gap: 0.3em;
}
.mainbar > button:not(.ws-icon) {
  padding: 0.65em 0.85em;
  border-radius: 0;
  border-bottom: 2px solid transparent;
}
.mainbar > button.active {
  border-bottom-color: var(--ws-blue);
  font-weight: 600;
}
.scope {
  margin-left: auto;
  font-size: 0.8em;
}
.workspace-content {
  flex: 1;
  min-height: 0;
}
.local-lists {
  height: 100%;
}
.local-lists :deep(.change-list) {
  height: 100%;
}
.editor-column {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.diff-area {
  flex: 1;
  min-height: 0;
}
.empty-editor {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 0.5em;
  color: var(--ws-muted);
}
.empty-editor > span {
  font-size: 3em;
  color: var(--ws-line);
}
.graph-drawer {
  position: absolute;
  z-index: 20;
  top: 4.8em;
  bottom: 1em;
  left: var(--outline-width);
  right: 30%;
  display: flex;
  flex-direction: column;
  padding: 1em;
  background: var(--ws-side);
  box-shadow: 0.8em 0.5em 2em #242a3420;
}
.graph-drawer header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.8em;
  padding: 0.2em 0.3em 0.8em;
}
.graph-drawer strong {
  font-size: 0.95em;
  font-weight: 500;
}
.expanded :deep(.outline-toggle) {
  left: calc(70% - 1em);
  color: var(--ws-blue);
}
.commit-result {
  display: flex;
  align-items: center;
  gap: 0.5em;
  border-bottom: 1px solid var(--ws-line);
  padding: 0.5em;
  color: var(--ws-green);
}
.commit-result .ws-icon {
  margin-left: auto;
}
.history-errors {
  padding: 0.4em;
  font-size: 0.85em;
}
</style>
