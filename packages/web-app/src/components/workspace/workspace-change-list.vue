<script setup lang="ts">
import { computed, ref } from 'vue';
import type { GitFileChange } from '@glink/protocol/git';
import type { WorkspaceDocument, WorkspaceProjectStatus } from '@glink/protocol/workspace';
import DiffTree from '../diff-tree.vue';
import TreeDisclosure from '../tree-disclosure.vue';
const props = defineProps<{
  workspace: WorkspaceDocument;
  statuses: WorkspaceProjectStatus[];
  staged: boolean;
  selected?: { projectId: string; path: string; staged: boolean };
  pendingIndex?: { projectId: string; path: string };
  busy: boolean;
}>();
const emit = defineEmits<{
  select: [projectId: string, file: GitFileChange];
  index: [projectId: string, file: GitFileChange];
}>();
const groups = computed(() =>
  props.workspace.projects
    .map((project) => {
      const status = props.statuses.find((item) => item.projectId === project.id);
      return {
        project,
        error: status?.error,
        files: (props.staged ? status?.staged : status?.unstaged) ?? [],
      };
    })
    .filter((group) => group.files.length || (!props.staged && group.error)),
);
const count = computed(() => groups.value.reduce((sum, group) => sum + group.files.length, 0));

function changeIndex(projectId: string, file: GitFileChange) {
  if (!props.busy && (props.staged || !file.stageBlockedReason)) {
    emit('index', projectId, file);
  }
}

const collapsedProjects = ref(new Set<string>());

function toggleProject(id: string) {
  if (collapsedProjects.value.has(id)) {
    collapsedProjects.value.delete(id);
  } else {
    collapsedProjects.value.add(id);
  }
}
</script>
<template>
  <section
    class="change-list ws-shared"
    :aria-label="staged ? 'Workspace staged' : 'Workspace unstaged'"
  >
    <header>
      {{ staged ? 'Staged' : 'Unstaged' }} <small class="muted">{{ count }}</small>
    </header>
    <div class="groups">
      <section
        v-for="group in groups"
        :key="group.project.id"
        class="group"
      >
        <h3 :title="group.project.worktreePath">
          <button
            class="group-toggle"
            :aria-expanded="!collapsedProjects.has(group.project.id)"
            :aria-controls="`changes-${staged}-${group.project.id}`"
            @click="toggleProject(group.project.id)"
          >
            <tree-disclosure :expanded="!collapsedProjects.has(group.project.id)" />
            {{ group.project.name }}<span class="count muted">{{ group.files.length }}</span>
          </button>
        </h3>
        <div
          v-show="!collapsedProjects.has(group.project.id)"
          :id="`changes-${staged}-${group.project.id}`"
        >
          <p
            v-if="group.error"
            class="ws-error"
            role="alert"
          >
            {{ group.error }}
          </p>
          <diff-tree
            :items="group.files"
            :repo-path="group.project.worktreePath"
            :disabled-paths="
              pendingIndex?.projectId === group.project.id ? [pendingIndex.path] : undefined
            "
            :model-value="
              selected?.projectId === group.project.id && selected.staged === staged
                ? selected.path
                : undefined
            "
            @select="emit('select', group.project.id, $event)"
            @activate="changeIndex(group.project.id, $event)"
          >
            <template #actions="{ item }">
              <button
                class="ws-icon"
                :disabled="busy || (!staged && !!item.stageBlockedReason)"
                :title="staged ? 'Unstage' : item.stageBlockedReason ?? 'Stage'"
                :aria-label="`${staged ? 'Unstage' : 'Stage'} ${group.project.name}: ${item.path}`"
                @click.stop="changeIndex(group.project.id, item)"
              >
                {{ staged ? '−' : '+' }}
              </button>
            </template>
          </diff-tree>
        </div>
      </section>
      <p
        v-if="!groups.length"
        class="ws-empty"
      >
        {{ staged ? 'No staged changes' : 'No unstaged changes' }}
      </p>
    </div>
  </section>
</template>
<style scoped lang="less">
.change-list {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
header {
  padding: 0.55em 0.8em;
  border-bottom: 1px solid var(--ws-line);
  font-weight: 500;
}
small {
  margin-left: 0.5em;
  font-weight: 400;
}
.groups {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding-bottom: 0.6em;
}
h3 {
  font-size: 0.92em;
  font-weight: 600;
  background: var(--ws-side);
  border-bottom: 1px solid var(--ws-line);
}
.group-toggle {
  display: flex;
  align-items: center;
  gap: 0.4em;
  width: 100%;
  padding: 0.55em 0.8em;
  text-align: left;
  border-radius: 0;
}
.count {
  margin-left: auto;
  font-weight: 400;
}
.group :deep(.file-tree) {
  padding: 0.25em;
}
</style>
