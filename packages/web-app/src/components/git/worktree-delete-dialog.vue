<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import {
  worktreePreflightChecks,
  WorktreePreflightState,
  type WorktreePreflightProgress,
  type WorktreeDeletionPlan,
  type WorktreeDeletionResult,
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
let controller: AbortController | undefined;
let mounted = true;
const canDelete = computed(() => !!plan.value && !loading.value && !working.value
  && checks.value.every((check) =>
    check.state === WorktreePreflightState.ok || check.state === WorktreePreflightState.warn));

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
  const token = plan.value!.token;
  plan.value = undefined;
  try {
    result.value = await app.workspaceService.deleteWorktree(token);
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
    if (mounted && !result.value.failed && !result.value.recordErrors.length) {
      emit('close');
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
  mounted = false;
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
    <p
      v-if="loading"
      role="status"
    >
      正在检查工作树和所有工作区引用…
    </p>
    <ol
      class="preflight"
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
          <small v-else>保留分支 {{ target.branch?.replace('refs/heads/', '') }}。</small>
          <small
            v-if="target.detached"
            class="warning"
          >Detached HEAD：{{ target.head }}，提交可能失去持久引用。</small>
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
    <template v-if="result">
      <p>已删除 {{ result.deleted.length }} 个工作树。</p>
      <ul>
        <li
          v-for="deletedPath in result.deleted"
          :key="deletedPath"
          class="path"
        >
          {{ deletedPath }}
        </li>
      </ul>
      <p
        v-if="result.failed"
        class="ws-error"
        role="alert"
      >
        删除失败：{{ result.failed.path }} — {{ result.failed.error }}。操作可能已部分完成，请检查后重试。
      </p>
      <p v-if="result.remaining.length">
        未完成：{{ result.remaining.join('、') }}
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
        {{ result ? '关闭' : '取消' }}
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
        v-if="!result"
        class="ws-button destructive"
        :disabled="!canDelete"
        @click="remove"
      >
        确认彻底删除
      </button>
      <span
        v-if="working"
        role="status"
      >正在删除，请勿关闭服务…</span>
    </footer>
  </dialog>
</template>
<style scoped lang="less">
.delete-dialog { width: min(46em, calc(100vw - 3em)); max-height: calc(100dvh - 3em);
  margin: auto; padding: 1.5em; border: 1px solid var(--ws-line); border-radius: .7em;
  background: var(--ws-side); color: var(--ws-text); overflow: auto; }
.delete-dialog::backdrop { background: #18223466; }
.preflight { list-style: none; padding: 0; margin: 1em 0; }
.check-heading { display: flex; align-items: center; gap: .65em; }
.check-icon { width: 1em; text-align: center; flex-shrink: 0; font-weight: 700; }
.preflight .pending { color: #9299a3; }
.preflight .in-progress { color: var(--ws-text); }
.preflight .ok { color: #25804b; }
.preflight .warn { color: #a9750a; }
.preflight .error { color: #c13b35; }
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
