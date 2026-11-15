<script setup lang="ts">
import { provide } from 'vue';
import type { WorkspaceProject } from '@glink/protocol/workspace';
import type { GitService } from '../../git/git-service';
import { GitRepoService, gitRepoServiceKey } from '../../git/git-repo-service';
import CommitDetailView from '../git/commit-detail-view.vue';
const props = defineProps<{ project: WorkspaceProject; sha: string; gitService: GitService }>();
provide(gitRepoServiceKey, new GitRepoService(props.gitService, props.project.worktreePath));
</script>
<template>
  <div class="workspace-detail ws-shared">
    <commit-detail-view :sha="sha" />
  </div>
</template>
<style scoped lang="less">
.workspace-detail {
  height: 100%;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
