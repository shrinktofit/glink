<script setup lang="ts">
import { computed, watch } from 'vue';
import type { GitCommitInput } from '@glink/protocol/git';

const props = defineProps<{
  busy?: boolean;
  hasStagedChanges: boolean;
  previousMessage?: string;
  commitBlockedReason?: string;
  amendBlockedReason?: string;
}>();
const summary = defineModel<string>('summary', { default: '' });
const description = defineModel<string>('description', { default: '' });
const amend = defineModel<boolean>('amend', { default: false });
const emit = defineEmits<{ submit: [input: GitCommitInput] }>();
const canSubmit = computed(() => {
  return !props.busy && !!summary.value.trim()
    && !(amend.value ? props.amendBlockedReason : props.commitBlockedReason)
    && (amend.value ? props.previousMessage !== undefined : props.hasStagedChanges);
});

watch(amend, (enabled) => {
  if (enabled && !summary.value && props.previousMessage) {
    const [first, ...rest] = props.previousMessage.split('\n');
    summary.value = first;
    description.value = rest.join('\n').trim();
  }
});
watch(() => props.amendBlockedReason, (reason) => {
  if (reason) {
    amend.value = false;
  }
});

function submit() {
  if (canSubmit.value) {
    const detail = description.value.trim();
    emit('submit', {
      message: summary.value.trim() + (detail ? `\n\n${detail}` : ''),
      amend: amend.value,
    });
  }
}
</script>

<template>
  <form
    class="commit-form"
    @submit.prevent="submit"
  >
    <input
      v-model="summary"
      aria-label="Commit message"
      placeholder="Commit subject"
      :disabled="busy"
    >
    <textarea
      v-model="description"
      aria-label="Commit description"
      placeholder="Description"
      :disabled="busy"
      @keydown.ctrl.enter.prevent="submit"
      @keydown.meta.enter.prevent="submit"
    />
    <div class="actions">
      <v-btn
        type="submit"
        size="small"
        color="primary"
        variant="flat"
        :loading="busy"
        :disabled="!canSubmit"
        :title="amend ? amendBlockedReason : commitBlockedReason"
      >
        Commit
      </v-btn>
      <label :title="amendBlockedReason">
        <input
          v-model="amend"
          type="checkbox"
          :disabled="busy || previousMessage === undefined || !!amendBlockedReason"
        >
        Amend
      </label>
    </div>
  </form>
</template>

<style scoped lang="less">
.commit-form {
  display: flex;
  flex-direction: column;
  gap: .3em;
  height: 100%;
  padding: 12px;
  input:not([type='checkbox']), textarea {
    width: 100%;
    border: 1px solid var(--divider);
    border-radius: 4px;
    padding: .35em .6em;
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
    &:focus { outline: 1px solid var(--accent); }
  }
  textarea { flex: 1; min-height: 2em; resize: none; }
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  .v-btn { order: 1; margin-left: auto; }
  label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  input { accent-color: var(--accent); }
}
</style>
