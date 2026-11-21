<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import {
  worktreePreflightChecks,
  WorktreePreflightState,
  WorktreeDeletionPhase,
  worktreeDeletionPhaseDescriptions,
  type WorktreePreflightProgress,
  type WorktreeDeletionPlan,
  type WorktreeDeletionResult,
  type WorktreeDeletionProgress,
} from '@glink/protocol/git';
import { appKey } from '../../app-context';
import { RouteName } from '../../router';

const props = defineProps<{ path: string }>();
const emit = defineEmits<{ close: [] }>();
const app = inject(appKey)!;
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const plan = ref<WorktreeDeletionPlan>();
const result = ref<WorktreeDeletionResult>();
const loading = ref(false);
const working = ref(false);
const error = ref('');
const checks = ref<WorktreePreflightProgress[]>([]);
const executionPlan = ref<WorktreeDeletionPlan>();
const progress = ref<WorktreeDeletionProgress>();
const targetProgress = ref<Record<string, WorktreeDeletionProgress>>({});
let controller: AbortController | undefined;
const canDelete = computed(() => !!plan.value && !loading.value && !working.value
  && checks.value.every((check) =>
    check.state === WorktreePreflightState.ok || check.state === WorktreePreflightState.warn));
const completed = computed(() => result.value?.deleted.length ?? progress.value?.completed ?? 0);
const executionRows = computed(() => executionPlan.value?.worktrees.map((target) => {
  const update = targetProgress.value[target.path];
  const phase = update?.phase ?? WorktreeDeletionPhase.queued;
  const interrupted = !!update && !!error.value && !working.value && !result.value
    && phase !== WorktreeDeletionPhase.deleted && phase !== WorktreeDeletionPhase.failed;
  const reference = executionPlan.value!.references.find((entry) =>
    entry.worktreePath.replaceAll('\\', '/').toLowerCase()
    === target.path.replaceAll('\\', '/').toLowerCase());
  return {
    path: target.path,
    name: reference?.projectName ?? target.path.replaceAll('\\', '/').split('/').at(-1),
    state: phase === WorktreeDeletionPhase.deleted
      ? WorktreePreflightState.ok
      : phase === WorktreeDeletionPhase.failed
        ? WorktreePreflightState.error
        : interrupted
          ? WorktreePreflightState.warn
          : phase === WorktreeDeletionPhase.queued
            ? WorktreePreflightState.pending
            : WorktreePreflightState.inProgress,
    description: interrupted
      ? `进度中断，最后收到：${worktreeDeletionPhaseDescriptions[phase]}`
      : result.value && phase === WorktreeDeletionPhase.queued
        ? '未执行'
        : worktreeDeletionPhaseDescriptions[phase],
    detail: update?.detail,
  };
}) ?? []);
const executionSummary = computed(() => {
  if (working.value) {
    return progress.value && worktreeDeletionPhaseDescriptions[progress.value.phase];
  }
  if (!result.value) {
    return '执行未完成';
  }
  if (result.value.failed) {
    return '删除已停止';
  }
  return result.value.recordErrors.length ? '工作树已删除，记录清理未完成' : '删除完成';
});

async function prepare() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  checks.value = worktreePreflightChecks.map((check) => ({
    id: check.id,
    state: WorktreePreflightState.pending,
  }));
  loading.value = true;
  error.value = '';
  plan.value = undefined;
  executionPlan.value = undefined;
  progress.value = undefined;
  targetProgress.value = {};
  result.value = undefined;
  try {
    const prepared = await app.workspaceService.planWorktreeDeletion(props.path, (progress) => {
      if (!request.signal.aborted) {
        checks.value = checks.value.map((check) => check.id === progress.id ? progress : check);
      }
    }, request.signal);
    if (!request.signal.aborted) {
      plan.value = prepared;
    }
  } catch (cause: unknown) {
    if (!request.signal.aborted) {
      error.value = String(cause);
      if (!checks.value.some((check) => check.state === WorktreePreflightState.error)) {
        const active = checks.value.find((check) =>
          check.state === WorktreePreflightState.inProgress)
        ?? checks.value.find((check) => check.state === WorktreePreflightState.pending);
        if (active) {
          checks.value = checks.value.map((check) => check.id === active.id
            ? { ...check, state: WorktreePreflightState.error, detail: String(cause) }
            : check);
        }
      }
    }
  } finally {
    if (!request.signal.aborted) {
      loading.value = false;
    }
  }
}

async function remove() {
  if (!canDelete.value) {
    return;
  }
  working.value = true;
  error.value = '';
  executionPlan.value = plan.value!;
  progress.value = {
    phase: WorktreeDeletionPhase.queued,
    completed: 0,
    total: executionPlan.value.worktrees.length,
  };
  const token = executionPlan.value.token;
  plan.value = undefined;
  try {
    result.value = await app.workspaceService.deleteWorktree(token, (update) => {
      progress.value = update;
      if (update.worktreePath) {
        targetProgress.value[update.worktreePath] = update;
      }
    });
    if (result.value.deleted.length) {
      const route = app.router.currentRoute.value;
      const current = String(route.params.worktreePath ?? '').replaceAll('\\', '/').toLowerCase();
      if (route.name === RouteName.worktree && result.value.deleted.some((path) => {
        const root = path.replaceAll('\\', '/').toLowerCase();
        return current === root || current.startsWith(`${root}/`);
      })) {
        await app.router.replace({ name: RouteName.starter });
      }
      app.deletionVersion.value++;
      await app.refreshCatalog();
    }
  } catch (cause: unknown) {
    error.value = String(cause);
  } finally {
    working.value = false;
  }
}

async function retryRecords() {
  working.value = true;
  error.value = '';
  progress.value = {
    phase: WorktreeDeletionPhase.records,
    completed: completed.value,
    total: executionPlan.value!.worktrees.length,
  };
  try {
    const response = await app.workspaceService.retryDeletionRecordCleanup(
      result.value!.cleanupToken!,
    );
    result.value!.recordErrors = response.recordErrors;
    app.deletionVersion.value++;
    await app.refreshCatalog();
  } catch (cause: unknown) {
    error.value = String(cause);
  } finally {
    working.value = false;
  }
}

onUnmounted(() => {
  controller?.abort();
});
onMounted(() => {
  dialog.value!.showModal();
  void prepare();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="delete-dialog workspace-theme ws-panel"
    aria-labelledby="delete-worktree-title"
    @cancel="working ? $event.preventDefault() : emit('close')"
  >
    <h2 id="delete-worktree-title">
      彻底删除工作树
    </h2>
    <p class="path">
      {{ path }}
    </p>
    <template v-if="!executionPlan">
      <p
        v-if="loading"
        role="status"
      >
        正在检查工作树和所有工作区引用…
      </p>
      <ol
        class="progress-list"
        aria-label="删除预检进度"
        aria-live="polite"
      >
        <li
          v-for="check in checks"
          :key="check.id"
          :class="check.state"
        >
          <div class="check-heading">
            <v-progress-circular
              v-if="check.state === WorktreePreflightState.inProgress"
              indeterminate
              :size="16"
              :width="2"
              aria-label="正在检查"
            />
            <span
              v-else
              class="check-icon"
              aria-hidden="true"
            >{{
              check.state === WorktreePreflightState.pending ? '●'
              : check.state === WorktreePreflightState.ok ? '✓'
                : check.state === WorktreePreflightState.warn ? '⚠' : '✕'
            }}</span>
            <span>{{
              worktreePreflightChecks.find((item) => item.id === check.id)!.description
            }}</span>
          </div>
          <p
            v-if="check.detail"
            class="check-detail"
          >
            {{ check.detail }}
          </p>
        </li>
      </ol>
      <template v-if="plan">
        <p class="warning">
          此操作不可撤销。未提交修改、未跟踪文件及被忽略文件都会被删除。
        </p>
        <ul>
          <li
            v-for="target in plan.worktrees"
            :key="target.path"
          >
            <strong>{{ target.main ? '主工作树' : 'Linked worktree' }}</strong>
            <span class="path">{{ target.path }}</span>
            <small
              v-if="target.main"
              class="warning"
            >将删除本地仓库数据，包括本地分支、stash 和未推送提交。
              子模块的仓库数据随其所属父仓库一并清理。</small>
            <small v-else-if="target.branch">
              保留仓库及分支 {{ target.branch.replace('refs/heads/', '') }}。
            </small>
            <small v-else>保留仓库及分支。</small>
            <small v-if="target.detached">Detached HEAD：{{ target.head }}</small>
            <small
              v-if="!target.main && target.head && !target.survivingRefs.length"
              class="warning"
            >当前提交没有删除后仍保留的引用，可能丢失。</small>
          </li>
        </ul>
        <template v-if="plan.references.length">
          <p>同时从以下工作区移除项目及关联：</p>
          <ul>
            <li
              v-for="reference in plan.references"
              :key="`${reference.workspaceId}/${reference.projectId}`"
            >
              {{ reference.workspaceName }} / {{ reference.projectName }}
            </li>
          </ul>
        </template>
        <p
          v-else
          class="muted"
        >
          没有工作区引用此工作树。
        </p>
      </template>
    </template>
    <section
      v-else
      class="execution"
      aria-label="删除执行进度"
    >
      <ol class="progress-list execution-targets">
        <li
          v-for="target in executionRows"
          :key="target.path"
          :class="target.state"
        >
          <div class="check-heading">
            <v-progress-circular
              v-if="target.state === WorktreePreflightState.inProgress"
              indeterminate
              :size="16"
              :width="2"
              aria-label="正在删除"
            />
            <span
              v-else
              class="check-icon"
              aria-hidden="true"
            >{{
              target.state === WorktreePreflightState.pending ? '●'
              : target.state === WorktreePreflightState.ok ? '✓'
                : target.state === WorktreePreflightState.warn ? '⚠' : '✕'
            }}</span>
            <strong>{{ target.name }}</strong>
          </div>
          <div class="check-detail">
            <span class="path">{{ target.path }}</span>
            <p class="target-step">
              {{ target.description }}
            </p>
            <p v-if="target.detail">
              {{ target.detail }}
            </p>
          </div>
        </li>
      </ol>
      <div
        class="execution-summary"
        role="status"
        aria-live="polite"
      >
        <span>已删除 {{ completed }} / {{ executionRows.length }} 个工作树</span>
        <span class="current-operation">
          <v-progress-circular
            v-if="working"
            indeterminate
            :size="14"
            :width="2"
            aria-hidden="true"
          />
          {{ executionSummary }}
        </span>
      </div>
      <v-progress-linear
        :model-value="completed / executionRows.length * 100"
        :height="4"
        rounded
        color="primary"
        aria-label="工作树删除完成数量"
      />
    </section>
    <template v-if="result">
      <p
        v-if="result.failed"
        class="ws-error"
        role="alert"
      >
        删除失败：{{ result.failed.path }} — {{ result.failed.error }}。操作可能已部分完成，请检查后重试。
      </p>
      <p
        v-for="entry in result.recordErrors"
        :key="entry.workspaceId"
        class="ws-error"
        role="alert"
      >
        磁盘删除已完成，但工作区 {{ entry.workspaceId }} 的记录清理失败：{{ entry.error }}
      </p>
    </template>
    <p
      v-if="error"
      class="ws-error"
      role="alert"
    >
      {{ error }}
    </p>
    <footer class="ws-actions">
      <button
        class="ws-button"
        :disabled="working"
        @click="emit('close')"
      >
        {{ executionPlan ? '关闭' : '取消' }}
      </button>
      <button
        v-if="error && !result"
        class="ws-button"
        :disabled="working || loading"
        @click="prepare"
      >
        重新检查
      </button>
      <button
        v-if="result?.recordErrors.length && result.cleanupToken"
        class="ws-button"
        :disabled="working"
        @click="retryRecords"
      >
        重试记录清理
      </button>
      <button
        v-if="!executionPlan"
        class="ws-button destructive"
        :disabled="!canDelete"
        @click="remove"
      >
        确认彻底删除
      </button>
    </footer>
  </dialog>
</template>
<style scoped lang="less">
.delete-dialog { width: min(46em, calc(100vw - 3em)); max-height: calc(100dvh - 3em);
  margin: auto; padding: 1.5em; border: 1px solid var(--ws-line); border-radius: .7em;
  background: var(--ws-side); color: var(--ws-text); overflow: auto; }
.delete-dialog::backdrop { background: #18223466; }
.progress-list { list-style: none; padding: 0; margin: 1em 0; }
.check-heading { display: flex; align-items: center; gap: .65em; }
.check-icon { width: 1em; text-align: center; flex-shrink: 0; font-weight: 700; }
.progress-list .pending { color: #9299a3; }
.progress-list .in-progress { color: var(--ws-text); }
.progress-list .ok { color: #25804b; }
.progress-list .warn { color: #a9750a; }
.progress-list .error { color: #c13b35; }
.execution { margin: 1em 0 1.5em; }
.execution-targets > li { margin: 1em 0; }
.execution-targets .path { opacity: .8; }
.execution-targets p { margin-bottom: 0; }
.target-step { margin-top: .35em; }
.execution-summary { display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: .5em 1em; margin: 1.2em 0 .6em; font-size: .9em; }
.current-operation { display: inline-flex; align-items: center; gap: .5em; }
.check-detail {
  margin: .3em 0 0 1.8em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: .9em;
}
h2 { font-size: 1.15em; margin-bottom: .7em; }
p, ul { margin-bottom: 1em; }
ul { padding-left: 1.4em; }
li { margin: .5em 0; }
.path { display: block; overflow-wrap: anywhere; font-size: .9em; }
small { display: block; margin-top: .2em; }
.warning { color: #a33a27; }
.destructive { background: #ac342b; color: white; }
footer { flex-wrap: wrap; }
</style>
