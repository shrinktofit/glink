<script setup lang="ts">
import { computed } from 'vue';
import type { WorkspaceBranch } from '@glink/protocol/workspace';
import { ProjectBindingKind, type WorkspaceProject } from '@glink/protocol/workspace';
import GitBranchSelect from './git-branch-select.vue';
const props = defineProps<{
  branches: readonly WorkspaceBranch[];
  label: string;
  disabled?: boolean;
  optional?: boolean;
}>();
const selection = defineModel<WorkspaceProject['binding']>({ required: true });
const kind = computed({
  get: () => selection.value.kind,
  set: (kind: ProjectBindingKind) => {
    const revision
      = kind === ProjectBindingKind.commit
        ? (props.branches.find((branch) => branch.revision === selection.value.revision)?.sha ?? '')
        : (props.branches.find((branch) => branch.sha === selection.value.revision)?.revision
          ?? '');
    selection.value = { kind, revision };
  },
});
const revision = computed({
  get: () => selection.value.revision,
  set: (revision: string) => {
    selection.value = { ...selection.value, revision };
  },
});
const invalid = computed(
  () =>
    selection.value.kind === ProjectBindingKind.commit
    && !!revision.value
    && !/^[a-f0-9]{4,64}$/i.test(revision.value),
);
</script>
<template>
  <div class="git-ref-field">
    <div
      class="git-ref-select"
      :aria-label="label"
    >
      <v-btn-toggle
        v-model="kind"
        class="ref-kind"
        :aria-label="`${label}类型`"
        :disabled="disabled"
        role="group"
        mandatory
        divided
        variant="flat"
        selected-class="selected"
      >
        <v-btn
          type="button"
          :value="ProjectBindingKind.branch"
        >
          分支
        </v-btn>
        <v-btn
          type="button"
          :value="ProjectBindingKind.commit"
        >
          提交
        </v-btn>
      </v-btn-toggle>
      <git-branch-select
        v-if="kind === ProjectBindingKind.branch"
        v-model="revision"
        :branches="branches"
        :label="label"
        :disabled="disabled"
      />
      <input
        v-else
        v-model="revision"
        :aria-label="label"
        :disabled="disabled"
        :required="!optional"
        :aria-invalid="invalid"
        pattern="[a-fA-F0-9]{4,64}"
        title="请输入 4–64 位十六进制 commit hash"
        placeholder="Commit hash"
        autocomplete="off"
        spellcheck="false"
      >
    </div>
    <p
      v-if="invalid"
      class="validation-error"
      role="alert"
    >
      请输入 4–64 位十六进制 commit hash
    </p>
  </div>
</template>
<style scoped lang="less">
.git-ref-select {
  display: flex;
  gap: 0.5em;
  align-items: stretch;
  min-width: 0;
}
.ref-kind {
  flex-shrink: 0;
  height: 2.7em;
  border: 1px solid var(--ws-line);
  border-radius: 0.45em;
  :deep(.v-btn) {
    min-width: 3.5em;
    padding: 0 0.7em;
    font: inherit;
    letter-spacing: normal;
  }
  :deep(.selected) {
    background: var(--ws-active);
    color: var(--ws-blue);
  }
}
.branch-select,
input {
  flex: 1;
  min-width: 0;
}
input {
  height: 2.7em;
  font-family: Consolas, monospace;
}
.validation-error {
  color: var(--ws-red);
  margin-top: 0.4em;
  font-size: 0.85em;
}
</style>
