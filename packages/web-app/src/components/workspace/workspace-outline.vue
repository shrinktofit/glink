<script setup lang="ts">
import { computed, inject, ref, useTemplateRef } from 'vue';
import { RouterLink } from 'vue-router';
import { appKey } from '../../app-context';
import { RouteName } from '../../router';
import {
  WorkspaceConnectionKind,
  type WorkspaceDocument,
  type WorkspaceProject,
  type WorkspaceProjectStatus,
} from '@glink/protocol/workspace';
import type { WorkspaceService } from '../../workspace/workspace-service';
import WorkspaceProjectEditor from './workspace-project-editor.vue';
const props = defineProps<{
  workspace: WorkspaceDocument;
  statuses: WorkspaceProjectStatus[];
  selected: readonly string[];
  service: WorkspaceService;
  busy: boolean;
}>();
const app = inject(appKey)!;
const expanded = defineModel<boolean>('expanded');
const emit = defineEmits<{
  changed: [workspace: WorkspaceDocument];
  select: [projectId: string, event: MouseEvent];
}>();
const editing = ref<WorkspaceProject>();
const context = ref<{ id?: string; x: number; y: number }>();
const addDialog = useTemplateRef<HTMLDialogElement>('add-dialog');
const path = ref('');
const parent = ref('');
const working = ref(false);
const error = ref('');
const selectedProject = computed(() =>
  props.workspace.projects.find((project) => project.id === context.value?.id),
);

function status(id: string) {
  return props.statuses.find((item) => item.projectId === id);
}

function state(id: string) {
  const value = status(id);
  if (!value) {
    return '…';
  }
  if (value.error) {
    return '!';
  }
  return value.staged.length || value.unstaged.length ? '●' : '○';
}

function projectTitle(project: WorkspaceProject) {
  const value = status(project.id);
  const clean = value?.error ?? (state(project.id) === '●' ? 'Not clean' : 'Clean');
  const lines = [
    project.worktreePath,
    `${clean} · ${project.settled ? 'Settled' : 'Unsettled'}`,
  ];
  if (value && !value.error && value.baselineCommit === project.baseline?.commit
    && value.aheadCount) {
    lines.push(`Ahead ${value.aheadCount} ${value.aheadCount === 1 ? 'commit' : 'commits'}`);
  }
  return lines.join('\n');
}

function bindingChanged(project: WorkspaceProject) {
  const value = status(project.id);
  if (!value || value.error) {
    return false;
  }
  return value.bindingMismatch;
}

function locked(id: string) {
  return props.workspace.connections.some(
    (edge) => edge.to === id && edge.kind === WorkspaceConnectionKind.submodule,
  );
}

function menu(event: MouseEvent, id?: string) {
  context.value = {
    id,
    x: Math.min(event.clientX, window.innerWidth - 220),
    y: Math.min(event.clientY, window.innerHeight - 150),
  };
}

function add(parentId = '') {
  parent.value = parentId;
  path.value = '';
  error.value = '';
  context.value = undefined;
  addDialog.value!.showModal();
}

async function addProject() {
  working.value = true;
  error.value = '';
  try {
    emit(
      'changed',
      await props.service.addProject(props.workspace.id, path.value, parent.value || undefined),
    );
    addDialog.value!.close();
  } catch (cause: unknown) {
    error.value = String(cause);
  } finally {
    working.value = false;
  }
}

async function remove() {
  const id = context.value!.id!;
  context.value = undefined;
  working.value = true;
  error.value = '';
  try {
    emit('changed', await props.service.removeProject(props.workspace.id, id));
  } catch (cause: unknown) {
    error.value = String(cause);
  } finally {
    working.value = false;
  }
}

function edit(id: string) {
  editing.value = props.workspace.projects.find((project) => project.id === id);
}

defineExpose({ edit });
</script>
<template>
  <aside
    class="outline ws-panel"
    @contextmenu.prevent="menu($event)"
    @keydown.esc="context = undefined"
  >
    <header>
      <strong>{{ workspace.name }}</strong><button
        class="ws-icon"
        aria-label="添加 Project"
        :disabled="busy || working"
        @click="add()"
      >
        ＋
      </button>
    </header>
    <div class="outline-heading">
      <span>Workspace Outline</span>
      <small class="muted">{{ workspace.projects.length }}</small>
    </div>
    <div
      class="projects"
      aria-label="Workspace outline"
    >
      <div
        v-for="project in workspace.projects"
        :key="project.id"
        class="project-row"
        :class="{ selected: selected.includes(project.id) }"
        @contextmenu.stop.prevent="menu($event, project.id)"
      >
        <button
          class="project-pick"
          :class="{ 'binding-changed': bindingChanged(project) }"
          :title="projectTitle(project)"
          :aria-pressed="selected.includes(project.id)"
          @click="emit('select', project.id, $event)"
        >
          <span
            class="clean-state"
            :class="{ dirty: state(project.id) === '●', unavailable: state(project.id) === '!' }"
          >{{ state(project.id) }}</span>
          <span class="name">{{ project.name }}</span>
          <span
            class="settlement"
            :class="{ settled: project.settled }"
            :aria-label="project.settled ? 'Settled' : 'Unsettled'"
          >{{ project.settled ? '✓' : '○' }}</span>
        </button>
        <button
          class="ws-icon"
          :aria-label="`编辑 ${project.name}`"
          :disabled="busy || working"
          @click="edit(project.id)"
        >
          ⋯
        </button>
      </div>
      <p
        v-if="!workspace.projects.length"
        class="ws-empty"
      >
        添加一个 worktree
      </p>
    </div>
    <p
      v-if="error && !addDialog?.open"
      class="ws-error"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="legend muted">
      <span class="dirty">●</span> Not clean · ○ Clean<br><span class="settled">✓</span> Settled ·
      ○ Unsettled
    </div>
    <footer class="muted">
      {{ workspace.projects.filter((project) => project.settled).length }} /
      {{ workspace.projects.length }} settled
    </footer>
    <button
      class="outline-toggle"
      aria-label="展开关系图"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? '<|' : '|>' }}
    </button>
    <template v-if="context">
      <div
        class="dismiss"
        @click="context = undefined"
      />
      <div
        class="context command-menu"
        role="menu"
        :style="{ left: `${context.x}px`, top: `${context.y}px` }"
      >
        <button
          role="menuitem"
          :disabled="busy || working"
          @click="add(context?.id)"
        >
          添加 Project{{ selectedProject ? ' 为依赖' : '' }}
        </button><template v-if="selectedProject">
          <hr role="separator">
          <router-link
            v-if="!status(selectedProject.id)?.error"
            role="menuitem"
            :to="{ name: RouteName.worktree, params: {
              worktreePath: selectedProject.worktreePath.replaceAll('\\', '/'),
            } }"
            @click="context = undefined"
          >打开工作树</router-link>
          <button
            v-else
            role="menuitem"
            disabled
            :title="status(selectedProject.id)?.error"
          >
            打开工作树
          </button>
          <button
            role="menuitem"
            :disabled="busy || working"
            @click="
              edit(selectedProject.id);
              context = undefined;
            "
          >
            编辑 Project
          </button>
          <hr role="separator">
          <button
            role="menuitem"
            :disabled="busy || working || locked(selectedProject.id)"
            :title="locked(selectedProject.id) ? '请先移除父 Project' : '仅移除工作区关联'"
            @click="remove"
          >
            移除 Project
          </button>
          <button
            role="menuitem"
            class="danger"
            :disabled="busy || working"
            @click="
              app.deleteWorktreePath.value = selectedProject.worktreePath;
              context = undefined;
            "
          >
            彻底删除工作树
          </button>
        </template>
      </div>
    </template>
    <dialog
      ref="add-dialog"
      @cancel="working && $event.preventDefault()"
    >
      <form @submit.prevent="addProject">
        <h2>添加 Project</h2>
        <label class="ws-field">Worktree 目录<input
          v-model="path"
          required
          :disabled="working"
          autofocus
        ></label><label class="ws-field">依赖此 Project 的项目<select
          v-model="parent"
          :disabled="working"
        >
          <option value="">无 · 根 Project</option>
          <option
            v-for="project in workspace.projects"
            :key="project.id"
            :value="project.id"
          >
            {{ project.name }}
          </option>
        </select></label>
        <p
          v-if="error"
          class="ws-error"
          role="alert"
        >
          {{ error }}
        </p>
        <div class="ws-actions">
          <button
            type="button"
            class="ws-button"
            :disabled="working"
            @click="addDialog!.close()"
          >
            取消
          </button><button
            class="ws-button primary"
            :disabled="working || !path.trim()"
          >
            添加
          </button>
        </div>
      </form>
    </dialog>
    <workspace-project-editor
      v-if="editing"
      :key="editing.id"
      :workspace="workspace"
      :project="editing"
      :service="service"
      @saved="emit('changed', $event)"
      @close="editing = undefined"
    />
  </aside>
</template>
<style scoped lang="less">
.outline {
  display: flex;
  flex-direction: column;
  background: var(--ws-side);
  padding: 1.2em;
  overflow: visible;
}
header {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin-bottom: 1.5em;
}
strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.outline-heading {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.7em;
  font-size: 0.9em;
}
.projects {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.project-row {
  display: flex;
  height: 2.45em;
  margin-bottom: 0.15em;
  border-radius: 0.4em;
}
.project-row.selected {
  background: var(--ws-active);
}
.project-pick {
  display: flex;
  align-items: center;
  gap: 0.6em;
  min-width: 0;
  flex: 1;
  padding: 0 0.4em;
  text-align: left;
}
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.binding-changed .name::after {
  content: ' ↯';
  color: var(--ws-orange);
}
.clean-state,
.settlement {
  color: var(--ws-muted);
}
.dirty {
  color: var(--ws-orange);
}
.unavailable {
  color: var(--ws-red);
}
.settled {
  color: var(--ws-green);
}
.legend {
  font-size: 0.8em;
  line-height: 1.8;
  margin: 1em 0;
}
footer {
  font-size: 0.85em;
  padding-top: 1em;
  border-top: 1px solid var(--ws-line);
}
.outline-toggle {
  position: absolute;
  z-index: 22;
  left: calc(var(--outline-width) - 1em);
  top: 5.5em;
  width: 2em;
  height: 2.3em;
  border: 1px solid var(--ws-line);
  background: var(--ws-surface);
  color: var(--ws-muted);
  font-family: Consolas, monospace;
}
.dismiss {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.context {
  position: fixed;
  z-index: 61;
}
</style>
