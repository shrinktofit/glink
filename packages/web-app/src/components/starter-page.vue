<script setup lang="ts">
import { inject, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import type { WorkspaceSummary } from '@glink/protocol/workspace';
import { appKey } from '../app-context';
import { RouteName } from '../router';
const app = inject(appKey)!;
const router = useRouter();
const catalog = app.catalog;
const dialog = useTemplateRef<HTMLDialogElement>('create-dialog');
const removal = ref<WorkspaceSummary>();
const removeDialog = useTemplateRef<HTMLDialogElement>('remove-dialog');
const name = ref('');
const paths = ref('');
const busy = ref(false);
const error = ref('');

const catalogController = new AbortController();
onMounted(async () => {
  try {
    await app.refreshCatalog(catalogController.signal);
  } catch (cause: unknown) {
    if (!catalogController.signal.aborted) {
      error.value = String(cause);
    }
  }
});
onUnmounted(() => catalogController.abort());

async function create() {
  busy.value = true;
  error.value = '';
  try {
    const workspace = await app.workspaceService.create({
      name: name.value,
      worktreePaths: paths.value
        .split('\n')
        .map((path) => path.trim())
        .filter(Boolean),
    });
    await app.refreshCatalog();
    dialog.value!.close();
    await router.push({ name: RouteName.workspace, params: { name: workspace.name } });
  } catch (cause: unknown) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  busy.value = true;
  error.value = '';
  try {
    await app.workspaceService.remove(removal.value!.id);
    await app.refreshCatalog();
    removeDialog.value!.close();
  } catch (cause: unknown) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="starter">
    <header>
      <div>
        <h1>你的工作，从这里连接。</h1>
        <p class="muted">
          把一起工作的仓库，放在同一个工作区。
        </p>
      </div>
      <button
        class="ws-button primary"
        @click="
          error = '';
          dialog!.showModal();
        "
      >
        ＋ 创建工作区
      </button>
    </header>
    <p
      v-if="error && !dialog?.open && !removeDialog?.open"
      class="ws-error"
      role="alert"
    >
      {{ error }}
    </p>
    <section
      class="workspace-grid"
      aria-label="Workspaces"
    >
      <article
        v-for="workspace in catalog?.workspaces"
        :key="workspace.id"
        class="workspace-card ws-panel"
      >
        <router-link
          class="workspace-open"
          :to="{ name: RouteName.workspace, params: { name: workspace.name } }"
        >
          <span class="workspace-symbol">◇</span>
          <h2>{{ workspace.name }}</h2>
          <p class="muted">
            {{ workspace.projectCount }} projects
          </p>
          <span class="open-arrow">↗</span>
        </router-link>
        <button
          class="remove ws-icon muted"
          :aria-label="`移除工作区 ${workspace.name}`"
          @click="
            removal = workspace;
            error = '';
            removeDialog!.showModal();
          "
        >
          ×
        </button>
      </article>
    </section>
    <div
      v-if="!catalog?.workspaces.length"
      class="ws-empty"
    >
      还没有工作区。创建一个，连接你的 worktree。
    </div>
    <dialog
      ref="create-dialog"
      @cancel="!busy || $event.preventDefault()"
    >
      <form @submit.prevent="create">
        <h2>创建工作区</h2>
        <label class="ws-field">名称<input
          v-model="name"
          required
          autofocus
          :disabled="busy"
        ></label><label class="ws-field">Worktree 目录<textarea
          v-model="paths"
          rows="5"
          placeholder="每行一个目录，也可以稍后添加"
          :disabled="busy"
        />
        </label>
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
            :disabled="busy"
            @click="dialog!.close()"
          >
            取消
          </button><button
            class="ws-button primary"
            :disabled="busy || !name.trim()"
          >
            {{ busy ? '创建中…' : '创建' }}
          </button>
        </div>
      </form>
    </dialog>
    <dialog ref="remove-dialog">
      <form @submit.prevent="remove">
        <h2>移除 {{ removal?.name }}？</h2>
        <p class="remove-note muted">
          仅移除工作区记录，保留所有 worktree。
        </p>
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
            :disabled="busy"
            @click="removeDialog!.close()"
          >
            取消
          </button><button
            class="ws-button"
            :disabled="busy"
          >
            移除
          </button>
        </div>
      </form>
    </dialog>
  </main>
</template>

<style scoped lang="less">
.starter {
  width: min(78em, 100%);
  margin: 5em auto;
  padding: 0 2em;
  overflow: auto;
}
header {
  display: flex;
  gap: 2em;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 3em;
}
h1 {
  font-size: 2.15em;
  font-weight: 600;
  letter-spacing: -0.04em;
  margin-bottom: 0.4em;
}
.workspace-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(21em, 1fr));
  gap: 1.2em;
}
.workspace-card {
  position: relative;
  overflow: hidden;
}
.workspace-open {
  display: block;
  color: inherit;
  text-decoration: none;
  width: 100%;
  text-align: left;
  padding: 1.7em;
  position: relative;
}
.workspace-open:hover { background: var(--ws-active); }
.workspace-symbol {
  display: inline-grid;
  place-items: center;
  width: 2em;
  height: 2em;
  font-size: 1.5em;
  background: var(--ws-active);
  color: var(--ws-blue);
  border-radius: 0.5em;
  margin-bottom: 1em;
}
h2 {
  font-size: 1.2em;
  font-weight: 600;
  margin-bottom: 0.4em;
}
.open-arrow {
  position: absolute;
  bottom: 1.5em;
  right: 1.5em;
  color: var(--ws-blue);
}
.remove {
  position: absolute;
  top: 0.7em;
  right: 0.7em;
  font-size: 1.3em;
}
.remove-note {
  padding: 1.5em 0;
}
</style>
