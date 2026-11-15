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
} from '@glink/protocol/workspace';
import { appKey } from '../../app-context';
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
const commits = ref<WorkspaceCommit[]>([]);
const historyErrors = ref<Array<{ projectId: string; error: string }>>([]);
const selectedProject = ref(workspace.value.projects[0]?.id);
const expanded = ref(false);
const busy = ref(false);
const pendingIndex = ref<{ projectId: string; path: string }>();
const loading = ref(false);
const refreshKey = ref(0);
const error = ref('');
const diffError = ref('');
const selection = ref<{ projectId: string; path: string; staged: boolean }>();
const diff = ref<FileDiffResponse>();
const diffTitle = computed(() => {
  const project = workspace.value.projects.find((item) => item.id === selection.value?.projectId);
  return selection.value ? `${project?.name} / ${selection.value.path}` : undefined;
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

async function refresh() {
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
    if (!document.projects.some((project) => project.id === selectedProject.value)) {
      selectedProject.value = document.projects[0]?.id;
    }
    const [state, history] = await Promise.all([
      service.status(workspace.value.id, controller.signal),
      service.history(workspace.value.id, controller.signal),
    ]);
    if (controller.signal.aborted) {
      return;
    }
    statuses.value = state;
    commits.value = history.commits;
    historyErrors.value = history.errors;
    if (selection.value) {
      const current = state.find((item) => item.projectId === selection.value!.projectId);
      const files = selection.value.staged ? current?.staged : current?.unstaged;
      if (!files?.some((file) => file.path === selection.value!.path)) {
        selection.value = undefined;
      }
    }
    refreshKey.value++;
    if (
      !selectedCommit.value
      || !history.commits.some(
        (commit) =>
          commit.sha === selectedCommit.value!.sha
          && commit.projectId === selectedCommit.value!.projectId,
      )
    ) {
      selectedCommit.value = history.commits[0];
    }
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

watch([selection, refreshKey], async ([selected], [previous]) => {
  if (
    selected?.projectId !== previous?.projectId
    || selected?.path !== previous?.path
    || selected?.staged !== previous?.staged
  ) {
    diff.value = undefined;
  }
  diffError.value = '';
  if (!selected) {
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
  if (!document.projects.some((project) => project.id === selectedProject.value)) {
    selectedProject.value = document.projects[0]?.id;
  }
  await refresh();
}

function selectFile(projectId: string, file: GitFileChange, staged: boolean) {
  selection.value = { projectId, path: file.path, staged };
  selectedProject.value = projectId;
}

async function index(projectId: string, file: GitFileChange, staged: boolean) {
  if (busy.value) {
    return;
  }
  busy.value = true;
  pendingIndex.value = { projectId, path: file.path };
  error.value = '';
  result.value = undefined;
  try {
    await service.changeIndex(
      workspace.value.id,
      projectId,
      file.path,
      staged ? GitIndexAction.unstage : GitIndexAction.stage,
    );
    await refresh();
  } catch (cause: unknown) {
    error.value = String(cause);
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
      v-model:selected="selectedProject"
      v-model:expanded="expanded"
      :workspace="workspace"
      :statuses="statuses"
      :service="service"
      :busy="busy"
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
          tab === WorkspaceTab.local ? 'All projects' : 'Base → HEAD · 500 max'
        }}</span><button
          class="ws-icon"
          :disabled="busy || loading"
          aria-label="刷新工作区"
          @click="refresh"
        >
          {{ loading ? '…' : '↻' }}
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
                :statuses="statuses"
                :staged="false"
                :selected="selection"
                :pending-index="pendingIndex"
                :busy="busy"
                @select="(projectId, file) => selectFile(projectId, file, false)"
                @index="(projectId, file) => index(projectId, file, false)"
              />
            </template><template #second>
              <workspace-change-list
                :workspace="workspace"
                :statuses="statuses"
                staged
                :selected="selection"
                :pending-index="pendingIndex"
                :busy="busy"
                @select="(projectId, file) => selectFile(projectId, file, true)"
                @index="(projectId, file) => index(projectId, file, true)"
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
              :loading="loading"
              @submit="commit"
            />
          </div>
        </template>
      </split-pane>
      <template v-if="tab === WorkspaceTab.history">
        <div
          v-if="historyErrors.length"
          class="history-errors"
        >
          <details>
            <summary class="muted">
              {{ historyErrors.length }} 个 Project 无法读取历史
            </summary>
            <p
              v-for="entry in historyErrors"
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
              :commits="commits"
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
        :selected="selectedProject"
        :statuses="statuses"
        @select="selectedProject = $event"
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
