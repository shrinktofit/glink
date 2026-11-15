<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
import {
  ProjectBindingKind,
  WorkspaceConnectionKind,
  type UpdateProjectInput,
  type WorkspaceBranch,
  type WorkspaceDocument,
  type WorkspaceProject,
} from '@glink/protocol/workspace';
import type { WorkspaceService } from '../../workspace/workspace-service';
import GitRefSelect from '../git/git-ref-select.vue';
const props = defineProps<{
  workspace: WorkspaceDocument;
  project: WorkspaceProject;
  service: WorkspaceService;
}>();
const emit = defineEmits<{ saved: [workspace: WorkspaceDocument]; close: [] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const name = ref(props.project.name);
const binding = ref({ ...props.project.binding });
const base = ref<WorkspaceProject['binding']>({
  kind: ProjectBindingKind.commit,
  revision: props.project.baseCommit ?? '',
});
const branches = ref<WorkspaceBranch[]>([]);
const loadingBranches = ref(true);
const settled = ref(props.project.settled);
const dependencies = ref(
  props.workspace.connections
    .filter((edge) => edge.from === props.project.id)
    .map((edge) => edge.to),
);
const locked = computed(
  () =>
    new Set(
      props.workspace.connections
        .filter(
          (edge) =>
            edge.from === props.project.id && edge.kind === WorkspaceConnectionKind.submodule,
        )
        .map((edge) => edge.to),
    ),
);
const busy = ref(false);
const error = ref('');
watch(dialog, (value) => value?.showModal());
const branchController = new AbortController();
onMounted(async () => {
  try {
    branches.value = await props.service.branches(
      props.workspace.id,
      props.project.id,
      branchController.signal,
    );
    const matches = branches.value.filter((branch) => branch.sha === props.project.baseCommit);
    const branch
      = matches.find((entry) => entry.revision === props.project.binding.revision)
        ?? matches.find((entry) => entry.current)
        ?? matches[0];
    if (branch) {
      base.value = { kind: ProjectBindingKind.branch, revision: branch.revision };
    }
  } catch (cause: unknown) {
    if (!branchController.signal.aborted) {
      error.value = String(cause);
    }
  } finally {
    loadingBranches.value = false;
  }
});
onUnmounted(() => branchController.abort());

async function save() {
  busy.value = true;
  error.value = '';
  try {
    const baseCommit = base.value.kind === ProjectBindingKind.branch
      ? branches.value.find((branch) => branch.revision === base.value.revision)?.sha
      : base.value.revision;
    const input: UpdateProjectInput = {
      name: name.value,
      baseCommit: baseCommit?.trim() ? baseCommit.trim() : undefined,
      settled: settled.value,
      binding: binding.value,
      dependencyIds: dependencies.value,
    };
    emit('saved', await props.service.updateProject(props.workspace.id, props.project.id, input));
    emit('close');
  } catch (cause: unknown) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <dialog
    ref="dialog"
    @cancel="busy ? $event.preventDefault() : emit('close')"
  >
    <form @submit.prevent="save">
      <h2>编辑 Project</h2>
      <p class="path muted">
        {{ project.worktreePath }}
      </p>
      <label class="ws-field">名称<input
        v-model="name"
        required
        :disabled="busy"
      ></label>
      <div class="ws-field">
        <span>关联</span>
        <git-ref-select
          v-model="binding"
          :branches="branches"
          label="关联"
          :disabled="busy || loadingBranches"
        />
      </div>
      <div class="ws-field">
        <span>基础提交</span>
        <git-ref-select
          v-model="base"
          :branches="branches"
          label="基础提交"
          optional
          :disabled="busy || loadingBranches"
        />
      </div>
      <label class="ws-check"><input
        v-model="settled"
        type="checkbox"
        :disabled="busy"
      >Settled</label>
      <fieldset :disabled="busy">
        <legend>依赖</legend>
        <label
          v-for="other in workspace.projects.filter((item) => item.id !== project.id)"
          :key="other.id"
          class="ws-check"
        >
          <v-tooltip
            text="Git 子模块自动建立的依赖。"
            :disabled="!locked.has(other.id)"
            :attach="dialog ?? true"
            location="top"
          >
            <template #activator="{ props: tooltipProps }">
              <span
                v-bind="tooltipProps"
                class="checkbox-target"
                :class="{ locked: locked.has(other.id) }"
              >
                <input
                  v-model="dependencies"
                  type="checkbox"
                  :value="other.id"
                  :disabled="locked.has(other.id)"
                >
              </span>
            </template>
          </v-tooltip>
          {{ other.name }}
        </label>
      </fieldset>
      <p
        v-if="error"
        class="ws-error"
        role="alert"
      >
        {{ error }}
      </p>
      <div class="ws-actions">
        <button
          type="button"
          class="ws-button"
          :disabled="busy"
          @click="emit('close')"
        >
          取消
        </button><button
          class="ws-button primary"
          :disabled="busy || loadingBranches || !binding.revision.trim()"
        >
          保存
        </button>
      </div>
    </form>
  </dialog>
</template>
<style scoped lang="less">
.path {
  font-size: 0.85em;
  overflow-wrap: anywhere;
  margin-top: 0.6em;
}
fieldset {
  border: 1px solid var(--ws-line);
  border-radius: 0.5em;
  padding: 0.7em;
  margin: 1em 0;
  max-height: 13em;
  overflow: auto;
}
.checkbox-target { display: inline-flex; align-items: center; }
.checkbox-target.locked input { pointer-events: none; }
</style>
