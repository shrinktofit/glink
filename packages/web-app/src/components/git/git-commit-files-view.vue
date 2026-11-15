<script setup lang="ts">
import { defineAsyncComponent, inject, onWatcherCleanup, ref, watch } from 'vue';
import type { GitCommitTreeEntry, GitCommitFileResponse } from '@glink/protocol/git';
import { gitRepoServiceKey } from '../../git/git-repo-service';
import FileTree from '../file-tree.vue';
import SplitPane from '../split-pane.vue';
const props = defineProps<{ sha: string }>();
const repo = inject(gitRepoServiceKey)!;
const CodeView = defineAsyncComponent(() => import('../code-view.vue'));
const files = ref<GitCommitTreeEntry[]>([]);
const selected = ref<string>();
const content = ref<GitCommitFileResponse>();
const loading = ref(false);
const treeError = ref('');
const fileError = ref('');
const columns = ref(0.27);
watch(
  () => props.sha,
  async (sha) => {
    const controller = new AbortController();
    onWatcherCleanup(() => controller.abort());
    files.value = [];
    selected.value = undefined;
    treeError.value = '';
    loading.value = true;
    try {
      const result = await repo.getCommitFiles(sha, controller.signal);
      if (!controller.signal.aborted) {
        files.value = result.files;
        selected.value = result.files[0]?.path;
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        treeError.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (!controller.signal.aborted) {
        loading.value = false;
      }
    }
  },
  { immediate: true },
);
watch([() => props.sha, selected], async ([sha, path]) => {
  content.value = undefined;
  fileError.value = '';
  if (!path) {
    return;
  }
  const controller = new AbortController();
  onWatcherCleanup(() => controller.abort());
  try {
    const result = await repo.getCommitFile(sha, path, controller.signal);
    if (!controller.signal.aborted) {
      content.value = result;
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      fileError.value = error instanceof Error ? error.message : String(error);
    }
  }
});
</script>
<template>
  <split-pane
    v-model="columns"
    class="commit-snapshot"
    aria-label="Commit snapshot"
  >
    <template #first>
      <div class="tree-scroll">
        <p
          v-if="treeError"
          class="status error"
          role="alert"
        >
          {{ treeError }}
        </p>
        <p
          v-else-if="loading"
          class="status"
          role="status"
        >
          Loading…
        </p>
        <file-tree
          v-else
          v-model="selected"
          :items="files"
          :default-expanded="false"
          aria-label="All commit files"
        />
        <p
          v-if="!loading && !treeError && !files.length"
          class="status"
        >
          No files
        </p>
      </div>
    </template>
    <template #second>
      <section
        class="snapshot-file"
        aria-label="Commit file content"
      >
        <header
          v-if="selected"
          :title="selected"
        >
          {{ selected }}
        </header>
        <p
          v-if="fileError"
          class="status error"
          role="alert"
        >
          {{ fileError }}
        </p>
        <p
          v-else-if="content?.binary"
          class="status"
        >
          Binary file
        </p>
        <code-view
          v-else-if="content"
          :content="content.content"
        />
        <p
          v-else-if="selected"
          class="status"
          role="status"
        >
          Loading…
        </p>
      </section>
    </template>
  </split-pane>
</template>
<style scoped lang="less">
.commit-snapshot {
  flex: 1;
  min-height: 0;
}
.tree-scroll {
  height: 100%;
  overflow: auto;
}
.snapshot-file {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
header {
  padding: 0.35em 0.75em;
  border-bottom: 1px solid var(--divider);
  font-size: 0.8125rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.code-view {
  flex: 1;
  min-height: 0;
}
.status {
  padding: 1em;
  color: var(--muted);
  font-size: 0.8125rem;
}
.error {
  color: var(--error);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
