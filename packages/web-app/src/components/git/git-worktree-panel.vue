<script setup lang="ts">
import { inject, shallowRef } from 'vue';
import { GitRepoService, gitRepoServiceKey } from '../../git/git-repo-service';
import GitRepositoryView from './git-repository-view.vue';

const initialRepo = inject(gitRepoServiceKey);
if (!initialRepo) {
  throw new Error('GitRepoService must be provided.');
}
const activeRepo = shallowRef(initialRepo);
const previousRepos = shallowRef<GitRepoService[]>([]);

function openRepository(path: string) {
  if (path.replace(/\\/g, '/') === activeRepo.value.repoPath.replace(/\\/g, '/')) {
    return;
  }
  previousRepos.value = [...previousRepos.value, activeRepo.value];
  activeRepo.value = new GitRepoService(activeRepo.value.gitService, path);
}

function goBack() {
  activeRepo.value = previousRepos.value.at(-1)!;
  previousRepos.value = previousRepos.value.slice(0, -1);
}
</script>

<template>
  <git-repository-view
    :key="activeRepo.repoPath"
    :repo="activeRepo"
    :can-go-back="!!previousRepos.length"
    @open-repository="openRepository"
    @back="goBack"
  />
</template>
