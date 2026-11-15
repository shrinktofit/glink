<script setup lang="ts">
import { computed, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { GitRepoService } from '../../git/git-repo-service';
import { appKey } from '../../app-context';
import { RouteName } from '../../router';
import GitRepositoryView from './git-repository-view.vue';

const props = defineProps<{ worktreePath: string }>();
const app = inject(appKey)!;
const router = useRouter();
const route = useRoute();
const activeRepo = computed(() => new GitRepoService(app.gitService, props.worktreePath));
const canGoBack = computed(
  () => !!route.fullPath && typeof router.options.history.state.back === 'string',
);

function openRepository(path: string) {
  if (path.replace(/\\/g, '/') === activeRepo.value.repoPath.replace(/\\/g, '/')) {
    return;
  }
  void router.push({
    name: RouteName.worktree,
    params: { worktreePath: path.replaceAll('\\', '/') },
  });
}
</script>

<template>
  <git-repository-view
    :key="activeRepo.repoPath"
    :repo="activeRepo"
    :can-go-back="canGoBack"
    @open-repository="openRepository"
    @back="router.back()"
  />
</template>
