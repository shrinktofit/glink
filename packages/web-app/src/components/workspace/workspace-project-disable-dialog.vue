<script setup lang="ts">
import { useTemplateRef, watch } from 'vue';
import type { ProjectDisableConfirmation } from '@glink/protocol/workspace';

defineProps<{
  projectName: string;
  confirmation: ProjectDisableConfirmation;
  busy: boolean;
  error?: string;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
watch(dialog, (value) => value?.showModal());
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="project-disable-title"
    @cancel="busy ? $event.preventDefault() : emit('cancel')"
  >
    <form @submit.prevent="emit('confirm')">
      <h2 id="project-disable-title">
        停用 {{ projectName }}？
      </h2>
      <ul class="reasons">
        <li
          v-for="reason in confirmation.reasons"
          :key="reason"
        >
          {{ reason }}
        </li>
      </ul>
      <p class="muted">
        停用后，该 Project 将从工作区提交过滤中隐藏。
      </p>
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
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          class="ws-button primary"
          :disabled="busy"
        >
          {{ busy ? '正在停用…' : '仍然停用' }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped lang="less">
.reasons {
  padding-left: 1.4em;
  margin: 1em 0;
  overflow-wrap: anywhere;
  li + li { margin-top: 0.5em; }
}
.ws-actions { margin-top: 1.2em; }
</style>
