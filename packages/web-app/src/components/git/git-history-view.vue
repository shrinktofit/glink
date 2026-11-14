<script setup lang="ts">
import { ref } from 'vue';
import type { GitCommit, GitReference } from '@glink/protocol/git';
import SplitPane from '../split-pane.vue';
import CommitGraph from './commit-graph.vue';
import CommitDetailView from './commit-detail-view.vue';

defineProps<{ refreshKey: number; references: GitReference[] }>();
const selected = defineModel<string>();
const rows = ref(0.5);

function loaded(commits: GitCommit[]) {
  if (!selected.value && commits.length) {
    selected.value = commits[0].sha;
  }
}
</script>

<template>
  <split-pane
    v-model="rows"
    vertical
    class="history-view"
    aria-label="Commit history layout"
  >
    <template #first>
      <commit-graph
        v-model="selected"
        :refresh-key="refreshKey"
        :references="references"
        @loaded="loaded"
      />
    </template>
    <template #second>
      <commit-detail-view :sha="selected" />
    </template>
  </split-pane>
</template>

<style scoped lang="less">
.commit-graph { height: 100%; }
</style>
