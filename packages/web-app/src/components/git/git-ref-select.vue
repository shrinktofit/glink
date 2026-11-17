<script setup lang="ts">
import { computed } from 'vue';
import { GitRevisionKind, type GitReferenceOption, type GitRevision } from '@glink/protocol/git';
import GitRefPicker from './git-ref-picker.vue';

const props = defineProps<{
  references: readonly GitReferenceOption[];
  label: string;
  disabled?: boolean;
  optional?: boolean;
}>();
const selection = defineModel<GitRevision>({ required: true });
const choices = [
  { kind: GitRevisionKind.branch, label: '分支' },
  { kind: GitRevisionKind.tag, label: '标签' },
  { kind: GitRevisionKind.commit, label: '提交' },
];
const kind = computed({
  get: () => selection.value.kind,
  set: (kind: GitRevisionKind) => {
    const selected = props.references.find((option) => option.ref === selection.value.revision);
    selection.value = {
      kind,
      revision: kind === GitRevisionKind.commit ? selected?.commit ?? '' : '',
    };
  },
});
const revision = computed({
  get: () => selection.value.revision,
  set: (revision: string) => {
    selection.value = { ...selection.value, revision };
  },
});
const options = computed(() => props.references.filter((option) => option.kind === kind.value));
const invalid = computed(() => kind.value === GitRevisionKind.commit
  && !!revision.value && !/^[a-f0-9]{4,64}$/i.test(revision.value));
</script>

<template>
  <div class="git-ref-field">
    <div
      class="git-ref-select"
      :aria-label="label"
    >
      <select
        v-model="kind"
        class="ref-kind"
        :aria-label="`${label}类型`"
        :disabled="disabled"
      >
        <option
          v-for="choice in choices"
          :key="choice.kind"
          :value="choice.kind"
        >
          {{ choice.label }}
        </option>
      </select>
      <git-ref-picker
        v-if="kind !== GitRevisionKind.commit"
        v-model="revision"
        :references="options"
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
      <div
        v-if="$slots.actions"
        class="ref-actions"
      >
        <slot name="actions" />
      </div>
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
  flex: 0 0 5.3em;
  height: 2.7em;
  padding: 0 0.6em;
  appearance: auto;
  border: 1px solid var(--ws-line);
  border-radius: 0.45em;
}
.reference-select,
input {
  flex: 1;
  min-width: 0;
}
input {
  height: 2.7em;
  font-family: Consolas, monospace;
}
.ref-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.validation-error {
  color: var(--ws-red);
  margin-top: 0.4em;
  font-size: 0.85em;
}
</style>
