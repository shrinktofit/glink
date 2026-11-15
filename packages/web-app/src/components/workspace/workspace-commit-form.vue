<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkspaceDocument, WorkspaceProjectStatus } from '@glink/protocol/workspace';
import { useWorkspaceCommitFilterStore } from '../../ui-state/workspace-commit-filter-store';
const props = defineProps<{
  workspace: WorkspaceDocument;
  statuses: WorkspaceProjectStatus[];
  busy: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{ submit: [projectIds: string[], message: string, amend: boolean] }>();
const filter = useWorkspaceCommitFilterStore();
const projectIds = computed(() => props.workspace.projects.map((project) => project.id));
const selected = computed({
  get() {
    const excluded = new Set(filter.excluded[props.workspace.id] ?? []);
    return projectIds.value.filter((id) => !excluded.has(id));
  },
  set(ids: string[]) {
    const included = new Set(ids);
    filter.excludeProjects(props.workspace.id, projectIds.value.filter((id) => !included.has(id)));
  },
});
const message = ref('');
const description = ref('');
const showFilter = ref(false);
const amend = ref(false);
watch(
  [() => props.workspace.id, projectIds],
  ([workspaceId, ids]) => filter.pruneProjects(workspaceId, ids),
  { immediate: true },
);
const eligible = computed(() =>
  props.statuses.filter(
    (status) => selected.value.includes(status.projectId) && status.staged.length,
  ),
);
const projectAmendBlockedReason = computed(() => {
  for (const id of selected.value) {
    const status = props.statuses.find((item) => item.projectId === id);
    const project = props.workspace.projects.find((item) => item.id === id)!;
    if (!status || status.error || !status.head || status.baseCommit !== project.baseCommit) {
      return `${project.name}: 等待有效的项目状态。`;
    }
    if (status.amendBlockedReason) {
      return `${project.name}: ${status.amendBlockedReason}`;
    }
  }
  return undefined;
});
const amendSelectionBlockedReason = computed(() =>
  selected.value.length === 1 ? undefined : '修订提交目前只能选择一个 Project。',
);
const amendBlockedReason = computed(() =>
  amendSelectionBlockedReason.value ?? projectAmendBlockedReason.value,
);
const commitBlockedReason = computed(() =>
  eligible.value.find((status) => status.commitBlockedReason)?.commitBlockedReason,
);
const canSubmit = computed(() =>
  !props.busy && !props.loading && !!message.value.trim()
  && (amend.value
    ? !amendBlockedReason.value
    : !!eligible.value.length && !commitBlockedReason.value),
);
watch(amendBlockedReason, (reason) => {
  if (reason) {
    amend.value = false;
  }
});
watch(amend, (enabled) => {
  const previous = props.statuses.find((status) => status.projectId === selected.value[0]);
  if (enabled && !message.value && previous?.headMessage) {
    const [first, ...rest] = previous.headMessage.split('\n');
    message.value = first;
    description.value = rest.join('\n').trim();
  }
});

function submit() {
  if (!canSubmit.value) {
    return;
  }
  emit(
    'submit',
    selected.value,
    message.value.trim() + (description.value.trim() ? `\n\n${description.value.trim()}` : ''),
    amend.value,
  );
}

function clear() {
  message.value = '';
  description.value = '';
  amend.value = false;
}

defineExpose({ clear });
</script>
<template>
  <form
    class="workspace-commit"
    @submit.prevent="submit"
  >
    <input
      v-model="message"
      aria-label="Workspace commit message"
      placeholder="Commit subject"
      :disabled="busy"
    >
    <textarea
      v-model="description"
      aria-label="Workspace commit description"
      placeholder="Description"
      :disabled="busy"
      rows="2"
      @keydown.ctrl.enter.prevent="submit"
    />
    <div class="ws-actions">
      <div class="filter">
        <button
          type="button"
          class="ws-button"
          :disabled="busy"
          :aria-expanded="showFilter"
          @click="showFilter = !showFilter"
        >
          Projects · {{ selected.length }}/{{ workspace.projects.length }} ▾
        </button>
        <div
          v-if="showFilter"
          class="filter-popover ws-panel"
        >
          <label
            v-for="project in workspace.projects"
            :key="project.id"
            class="ws-check"
          ><input
            v-model="selected"
            type="checkbox"
            :value="project.id"
            :disabled="busy"
          >{{
            project.name
          }}<small class="muted">{{
            statuses.find((status) => status.projectId === project.id)?.staged.length ?? 0
          }}
            staged</small></label>
        </div>
      </div>
      <v-tooltip
        :text="loading ? '正在刷新项目状态。' : amendBlockedReason"
        :disabled="!loading && !amendBlockedReason"
        location="top"
      >
        <template #activator="{ props: tooltipProps }">
          <label
            v-bind="tooltipProps"
            class="ws-check amend-option"
          >
            <input
              v-model="amend"
              type="checkbox"
              :disabled="busy || loading || !!amendBlockedReason"
            >Amend
          </label>
        </template>
      </v-tooltip>
      <span class="scope muted">{{
        amend ? '1 to amend' : `${eligible.length} to commit`
      }}</span><button
        class="ws-button primary"
        :disabled="!canSubmit"
        :title="amend ? amendBlockedReason : commitBlockedReason"
      >
        {{ busy ? 'Committing…' : amend ? 'Amend commit' : 'Commit workspace' }}
      </button>
    </div>
  </form>
</template>
<style scoped lang="less">
.workspace-commit {
  padding: 0.8em;
  border-top: 1px solid var(--ws-line);
  flex-shrink: 0;
}
input:not([type='checkbox']),
textarea {
  display: block;
  width: 100%;
  margin-bottom: 0.5em;
  font-size: 0.92em;
}
textarea {
  resize: vertical;
  max-height: 12em;
}
.filter {
  position: relative;
}
.filter-popover {
  position: absolute;
  bottom: calc(100% + 0.5em);
  left: 0;
  width: 24em;
  max-height: 22em;
  overflow: auto;
  padding: 0.8em;
  z-index: 25;
  box-shadow: 0 0.5em 2em #242a3420;
}
.ws-check {
  padding: 0.3em;
}
small {
  margin-left: auto;
}
.scope {
  margin-left: auto;
  font-size: 0.85em;
}
.amend-option:has(input:disabled) {
  color: var(--ws-muted);
}
</style>
