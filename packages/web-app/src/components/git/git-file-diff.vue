<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import type { FileDiffResponse } from '@glink/protocol/git';

defineProps<{ path?: string; diff?: FileDiffResponse; error?: string }>();
const emit = defineEmits<{ close: [] }>();
const DiffView = defineAsyncComponent(() => import('../diff-view.vue'));
</script>

<template>
  <section
    class="file-diff"
    aria-label="File diff"
  >
    <header v-if="path">
      <span :title="path">{{ path }}</span>
      <button
        class="icon-button"
        aria-label="Close diff"
        @click="emit('close')"
      >
        ×
      </button>
    </header>
    <p
      v-if="error"
      class="status error"
      role="alert"
    >
      {{ error }}
    </p>
    <diff-view
      v-else-if="diff && path"
      :original="diff.original"
      :modified="diff.modified"
    />
    <p
      v-else-if="path"
      class="status"
      role="status"
    >
      Loading…
    </p>
  </section>
</template>

<style scoped lang="less">
.file-diff { display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
  }
header { display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  min-height: 1.8em;
  padding: 0 .75em;
  font-size: .8125rem;
  border-bottom: 1px solid var(--divider);
  }
header span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-view { flex: 1; min-height: 0; }
.status { padding: 1em; font-size: .8125rem; color: var(--muted); }
.error { color: var(--error); white-space: pre-wrap; overflow: auto; }
</style>
