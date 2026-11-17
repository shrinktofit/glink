<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
import { GitRevisionKind, type GitReferenceOption } from '@glink/protocol/git';
import {
  WorkspaceConnectionKind,
  type UpdateProjectInput,
  type ProjectBaseline,
  type WorkspaceDocument,
  type WorkspaceProject,
} from '@glink/protocol/workspace';
import type { WorkspaceService } from '../../workspace/workspace-service';
import GitRefSelect from '../git/git-ref-select.vue';
import WorkspaceBaselineEditor from './workspace-baseline-editor.vue';
const props = defineProps<{
  workspace: WorkspaceDocument;
  project: WorkspaceProject;
  service: WorkspaceService;
}>();
const emit = defineEmits<{ saved: [workspace: WorkspaceDocument]; close: [] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const name = ref(props.project.name);
const binding = ref({ ...props.project.binding });
const baseline = ref<ProjectBaseline | undefined>(
  props.project.baseline && { ...props.project.baseline },
);
const baselineValid = ref(true);
const references = ref<GitReferenceOption[]>([]);
const loadingReferences = ref(true);
const referenceError = ref(false);
const missingAssociation = computed(() => !loadingReferences.value && !referenceError.value
  && binding.value.kind !== GitRevisionKind.commit && !!binding.value.revision
  && !references.value.some((option) => option.ref === binding.value.revision));
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
const referencesController = new AbortController();
onMounted(async () => {
  try {
    references.value = await props.service.references(
      props.workspace.id,
      props.project.id,
      referencesController.signal,
    );
  } catch (cause: unknown) {
    if (!referencesController.signal.aborted) {
      referenceError.value = true;
      error.value = String(cause);
    }
  } finally {
    loadingReferences.value = false;
  }
});
onUnmounted(() => referencesController.abort());

function compareBaseline(value: ProjectBaseline & { ref: string }, signal: AbortSignal) {
  return props.service.compareBaseline(props.workspace.id, props.project.id, value, signal);
}

async function save() {
  busy.value = true;
  error.value = '';
  try {
    const input: UpdateProjectInput = {
      name: name.value,
      baseline: baseline.value,
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
          :references="references"
          label="关联"
          :disabled="busy || loadingReferences"
        >
          <template
            v-if="missingAssociation"
            #actions
          >
            <v-tooltip
              text="关联的引用不存在或未指向提交。"
              :attach="dialog ?? true"
              location="top"
            >
              <template #activator="{ props: tooltipProps }">
                <span
                  v-bind="tooltipProps"
                  class="association-warning"
                  tabindex="0"
                  role="img"
                  aria-label="关联引用不可用"
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="m10 2 8 15H2L10 2Z"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linejoin="round"
                    />
                    <path
                      d="M10 7v5m0 2v.5"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                    />
                  </svg>
                </span>
              </template>
            </v-tooltip>
          </template>
        </git-ref-select>
      </div>
      <div class="ws-field">
        <span>基线</span>
        <workspace-baseline-editor
          v-model="baseline"
          :references="references"
          :compare="compareBaseline"
          :tooltip-container="dialog ?? undefined"
          :disabled="busy || loadingReferences"
          @validity="baselineValid = $event"
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
          :disabled="busy || loadingReferences || !binding.revision.trim() || !baselineValid"
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
.association-warning {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ws-orange);
  width: 2em;
  svg { width: 1.35em; height: 1.35em; }
}
</style>
