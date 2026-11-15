<script setup lang="ts">
import { ref } from 'vue';
import type {
  FileDiffResponse,
  GitCommitInput,
  GitFileChange,
  GitIndexAction,
  WorktreeStatus,
} from '@glink/protocol/git';
import SplitPane from '../split-pane.vue';
import GitChangeList from './git-change-list.vue';
import GitCommitForm from './git-commit-form.vue';
import GitFileDiff from './git-file-diff.vue';
import type { GitIndexTarget } from '../../git/git-index-target';

defineProps<{
  status: WorktreeStatus;
  statusReady: boolean;
  selected?: { file: GitFileChange; staged: boolean };
  pendingPath?: string;
  diff?: FileDiffResponse;
  diffError?: string;
  error?: string;
  busy: boolean;
  loading: boolean;
}>();
const summary = defineModel<string>('summary', { required: true });
const description = defineModel<string>('description', { required: true });
const amend = defineModel<boolean>('amend', { required: true });
const emit = defineEmits<{
  select: [file: GitFileChange, staged: boolean];
  close: [];
  changeIndex: [target: GitIndexTarget, action: GitIndexAction];
  commit: [input: GitCommitInput];
}>();
const columns = ref(0.28);
const lists = ref(0.55);
</script>

<template>
  <split-pane
    v-model="columns"
    class="local-changes"
    aria-label="Local changes layout"
  >
    <template #first>
      <split-pane
        v-model="lists"
        vertical
      >
        <template #first>
          <git-change-list
            :items="status.unstaged"
            :ready="statusReady"
            :staged="false"
            :selected-path="selected && !selected.staged ? selected.file.path : undefined"
            :pending-path="pendingPath"
            :busy="busy"
            :loading="loading"
            @select="emit('select', $event, false)"
            @change-index="(target, action) => emit('changeIndex', target, action)"
          />
        </template>
        <template #second>
          <git-change-list
            :items="status.staged"
            :ready="statusReady"
            staged
            :selected-path="selected?.staged ? selected.file.path : undefined"
            :pending-path="pendingPath"
            :busy="busy"
            :loading="loading"
            @select="emit('select', $event, true)"
            @change-index="(target, action) => emit('changeIndex', target, action)"
          />
        </template>
      </split-pane>
    </template>
    <template #second>
      <div class="editor-and-commit">
        <git-file-diff
          :path="selected?.file.path"
          :diff="diff"
          :error="diffError"
          @close="emit('close')"
        />
        <p
          v-if="error"
          class="error"
          role="alert"
        >
          {{ error }}
        </p>
        <git-commit-form
          v-model:summary="summary"
          v-model:description="description"
          v-model:amend="amend"
          :busy="busy"
          :has-staged-changes="!!status.staged.length && !loading"
          :previous-message="loading ? undefined : status.headMessage"
          :commit-blocked-reason="status.commitBlockedReason"
          :amend-blocked-reason="status.amendBlockedReason"
          @submit="emit('commit', $event)"
        />
      </div>
    </template>
  </split-pane>
</template>

<style scoped lang="less">
.editor-and-commit { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.file-diff { flex: 1; min-height: 0; }
.commit-form { flex-shrink: 0; height: 8.8em; border-top: 1px solid var(--divider); }
.error { flex-shrink: 0;
  max-height: 6em;
  overflow: auto;
  padding: .5em .8em;
  color: var(--error);
  font-size: .8125rem;
  white-space: pre-wrap;
  }
</style>
