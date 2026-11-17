<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import { GitIndexAction, type GitFileChange } from '@glink/protocol/git';
import type { WorkspaceDocument, WorkspaceProjectStatus } from '@glink/protocol/workspace';
import DiffTree from '../diff-tree.vue';
import TreeDisclosure from '../tree-disclosure.vue';
import { useExpansionState } from '../../ui-state/use-expansion-state';
import { useExpansionStateStore } from '../../ui-state/expansion-state-store';
import { gitChangesTreeStateKey } from '../../git/git-changes-tree-state-key';
import { GitIndexScope } from '../../git/git-index-target';
import type {
  PendingWorkspaceIndex,
  WorkspaceIndexTarget,
} from '../../workspace/workspace-index-target';
import { workspaceChangeGroups } from '../../workspace/workspace-change-groups';
import { fileTreeSelectionScopeKey, type FileTreeSelectionScope } from '../file-tree-selection';
const props = defineProps<{
  workspace: WorkspaceDocument;
  projectIds: readonly string[];
  statuses: WorkspaceProjectStatus[];
  staged: boolean;
  selected?: { projectId: string; path: string; staged: boolean };
  selection: FileTreeSelectionScope;
  pendingIndex: readonly PendingWorkspaceIndex[];
  busy: boolean;
  loading: boolean;
}>();
const grouped = computed(() => props.projectIds.length > 1);
const emit = defineEmits<{
  select: [projectId: string, file: GitFileChange];
  index: [targets: readonly WorkspaceIndexTarget[]];
}>();
const groups = computed(() => workspaceChangeGroups(
  props.workspace.projects, props.statuses, props.projectIds, props.staged,
));
provide(fileTreeSelectionScopeKey, props.selection);
const changeGroups = computed(() => groups.value.map((group) => ({
  id: group.project.id,
  repoPath: group.project.worktreePath,
  files: group.files,
})));
const count = computed(() => groups.value.reduce((sum, group) => sum + group.files.length, 0));

function changeIndex(projectId: string, file: GitFileChange) {
  if (!props.busy && !props.loading && (props.staged || !file.stageBlockedReason)) {
    emit('index', [{ projectId, scope: GitIndexScope.file, path: file.path }]);
  }
}

const context = ref<{ projectId: string; x: number; y: number }>();
const contextGroup = computed(() =>
  groups.value.find((group) => group.project.id === context.value?.projectId),
);
const canChangeAll = computed(() =>
  !props.busy && !props.loading && !contextGroup.value?.error
  && !!contextGroup.value?.files.some((file) => props.staged || !file.stageBlockedReason),
);
watch([
  () => props.busy,
  () => props.loading,
  contextGroup,
  grouped,
], ([
  busy,
  loading,
  group,
  grouped,
]) => {
  if (busy || loading || !group || !grouped) {
    context.value = undefined;
  }
});

function openContext(event: MouseEvent, projectId: string) {
  if (props.busy || props.loading) {
    return;
  }
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  context.value = {
    projectId,
    x: event.clientX || bounds.left,
    y: event.clientY || bounds.bottom,
  };
}

function changeAll() {
  if (canChangeAll.value) {
    const projectId = context.value!.projectId;
    context.value = undefined;
    emit('index', [{ projectId, scope: GitIndexScope.worktree }]);
  }
}

const { isExpanded, setExpanded } = useExpansionState(
  () => JSON.stringify(['workspace-change-groups', props.workspace.id, props.staged]),
  () => props.workspace.projects.map((project) => project.id),
  true,
);
watch(() => props.selected, (selected) => {
  if (grouped.value && selected?.staged === props.staged) {
    setExpanded([selected.projectId], true);
  }
});
const cache = useExpansionStateStore();
watch(() => [props.statuses, props.workspace.projects], () => {
  // Empty successful lists have no mounted tree to capture a new snapshot.
  for (const project of props.workspace.projects) {
    const status = props.statuses.find((item) => item.projectId === project.id);
    if (status && !status.error && !(props.staged ? status.staged : status.unstaged).length) {
      cache.remove(gitChangesTreeStateKey(project.worktreePath, props.staged));
    }
  }
}, { immediate: true });

function toggleProject(id: string) {
  setExpanded([id], !isExpanded(id));
}

function pendingPaths(projectId: string) {
  const pending = props.pendingIndex.find((entry) => entry.projectId === projectId);
  if (!pending) {
    return [];
  }
  return pending.paths ?? groups.value.find((group) => group.project.id === projectId)!.files
    .map((file) => file.path);
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
        :aria-busy="pendingIndex.some((entry) => entry.projectId === group.project.id)"
      >
        <h3
          v-if="grouped"
          :title="group.project.worktreePath"
          @contextmenu.stop.prevent="openContext($event, group.project.id)"
        >
          <button
            class="group-toggle"
            aria-haspopup="menu"
            :aria-expanded="isExpanded(group.project.id)"
            :aria-controls="`changes-${staged}-${group.project.id}`"
            @click="toggleProject(group.project.id)"
          >
            <tree-disclosure :expanded="isExpanded(group.project.id)" />
            {{ group.project.name }}<span class="count muted">{{ group.files.length }}</span>
          </button>
        </h3>
        <div
          v-show="!grouped || isExpanded(group.project.id)"
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
            :change-groups="changeGroups"
            :state-key="gitChangesTreeStateKey(group.project.worktreePath, staged)"
            :data-ready="!group.error"
            :selection-group="group.project.id"
            :selection-visible="!grouped || isExpanded(group.project.id)"
            reveal-selection
            :index-action="staged ? GitIndexAction.unstage : GitIndexAction.stage"
            :index-disabled="busy || loading"
            :disabled-paths="pendingPaths(group.project.id)"
            :model-value="
              selected?.projectId === group.project.id && selected.staged === staged
                ? selected.path
                : undefined
            "
            @select="emit('select', group.project.id, $event)"
            @activate="changeIndex(group.project.id, $event)"
            @index-directory="
              emit('index', [{
                projectId: group.project.id,
                scope: GitIndexScope.directory,
                path: $event,
              }])
            "
            @index-selection="emit('index', $event.map((batch) => ({
              projectId: batch.group,
              scope: GitIndexScope.paths,
              paths: batch.paths,
            })))"
          >
            <template #actions="{ item }">
              <button
                class="ws-icon"
                :disabled="busy || loading || (!staged && !!item.stageBlockedReason)"
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
    <v-menu
      v-if="context"
      :model-value="true"
      :target="[context.x, context.y]"
      location="bottom start"
      content-class="command-menu-overlay"
      :transition="false"
      @update:model-value="!$event && (context = undefined)"
    >
      <v-list
        class="command-menu"
        density="compact"
        role="menu"
        aria-label="项目修改操作"
      >
        <v-list-item
          role="menuitem"
          :disabled="!canChangeAll"
          :aria-disabled="!canChangeAll"
          :ripple="false"
          @click="changeAll"
        >
          {{ staged ? '取消所有暂存' : '暂存所有' }}
        </v-list-item>
      </v-list>
    </v-menu>
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
.group[aria-busy='true'] > h3 {
  opacity: 0.5;
}
</style>
