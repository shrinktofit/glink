<script setup lang="ts">
import { inject, onWatcherCleanup, ref, watch } from 'vue';
import type { FileDiffResponse, GitCommitDetail } from '@glink/protocol/git';
import { gitRepoServiceKey } from '../../git/git-repo-service';
import DiffTree from '../diff-tree.vue';
import SplitPane from '../split-pane.vue';
import GitCommitInfo from './git-commit-info.vue';
import GitFileDiff from './git-file-diff.vue';

const props = defineProps<{ sha?: string }>();
const repo = inject(gitRepoServiceKey);
if (!repo) {
  throw new Error('GitRepoService must be provided.');
}
const detail = ref<GitCommitDetail>();
const selectedPath = ref<string>();
const diff = ref<FileDiffResponse>();
const detailError = ref('');
const diffError = ref('');
const columns = ref(0.27);
enum DetailTab {
  commit = 'commit',
  changes = 'changes',
}
const tab = ref(DetailTab.changes);

watch(() => props.sha, async (sha) => {
  detail.value = undefined;
  detailError.value = '';
  selectedPath.value = undefined;
  if (!sha) {
    return;
  }
  const controller = new AbortController();
  onWatcherCleanup(() => controller.abort());
  try {
    const result = await repo.getCommitDetail(sha, controller.signal);
    if (!controller.signal.aborted) {
      detail.value = result;
      selectedPath.value = result.files[0]?.path;
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      detailError.value = error instanceof Error ? error.message : String(error);
    }
  }
}, { immediate: true });

watch([detail, selectedPath], async ([commit, path]) => {
  diff.value = undefined;
  diffError.value = '';
  if (!commit || !path) {
    return;
  }
  const controller = new AbortController();
  onWatcherCleanup(() => controller.abort());
  try {
    const result = await repo.getCommitDiff(commit.sha, path, controller.signal);
    if (!controller.signal.aborted) {
      diff.value = result;
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      diffError.value = error instanceof Error ? error.message : String(error);
    }
  }
});
</script>

<template>
  <section
    class="commit-detail"
    aria-label="Commit detail"
  >
    <v-tabs
      v-model="tab"
      height="30"
      class="detail-tabs"
    >
      <v-tab :value="DetailTab.commit">
        Commit
      </v-tab>
      <v-tab :value="DetailTab.changes">
        Changes
      </v-tab>
    </v-tabs>
    <p
      v-if="detailError"
      class="status error"
      role="alert"
    >
      {{ detailError }}
    </p>
    <template v-else-if="detail">
      <git-commit-info
        v-if="tab === DetailTab.commit"
        :commit="detail"
      />
      <template v-else>
        <git-commit-info
          :commit="detail"
          compact
        />
        <split-pane
          v-model="columns"
          class="commit-changes"
        >
          <template #first>
            <div class="commit-files">
              <diff-tree
                v-model="selectedPath"
                :items="detail.files"
                aria-label="Commit files"
              />
              <p
                v-if="!detail.files.length"
                class="status"
              >
                No file changes
              </p>
            </div>
          </template>
          <template #second>
            <git-file-diff
              :path="selectedPath"
              :diff="diff"
              :error="diffError"
              @close="selectedPath = undefined"
            />
          </template>
        </split-pane>
      </template>
    </template>
    <p
      v-else-if="sha"
      class="status"
      role="status"
    >
      Loading…
    </p>
  </section>
</template>

<style scoped lang="less">
.commit-detail { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.detail-tabs { flex-shrink: 0; border-bottom: 1px solid var(--divider); }
.commit-changes { flex: 1; min-height: 0; }
.commit-files { height: 100%; min-height: 0; overflow: auto; }
.status { padding: 1em; color: var(--muted); font-size: .8125rem; }
.error { color: var(--error); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
