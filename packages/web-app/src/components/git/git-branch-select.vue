<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue';
import type { WorkspaceBranch } from '@glink/protocol/workspace';
const props = defineProps<{
  branches: readonly WorkspaceBranch[];
  label: string;
  disabled?: boolean;
}>();
const selected = defineModel<string>({ required: true });
const open = ref(false);
const search = ref('');
const active = ref(0);
const id = useId();
const searchInput = useTemplateRef<HTMLInputElement>('search');
const trigger = useTemplateRef<HTMLButtonElement>('trigger');
const filtered = computed(() =>
  props.branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
  ),
);
watch(search, () => {
  active.value = 0;
});

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    search.value = '';
    active.value = Math.max(
      0,
      props.branches.findIndex((branch) => branch.revision === selected.value),
    );
    await nextTick();
    searchInput.value!.focus();
  }
}

function pick(branch: WorkspaceBranch) {
  selected.value = branch.revision;
  open.value = false;
  trigger.value!.focus();
}

function focusout(event: FocusEvent) {
  if (
    !(event.relatedTarget instanceof Node)
    || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)
  ) {
    open.value = false;
  }
}

function keydown(event: KeyboardEvent) {
  if (!open.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      void toggle();
    }
    return;
  }
  if (event.key === 'Escape') {
    open.value = false;
    trigger.value!.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    active.value = Math.max(
      0,
      Math.min(filtered.value.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)),
    );
  } else if (event.key === 'Enter' && filtered.value[active.value]) {
    pick(filtered.value[active.value]);
  } else {
    return;
  }
  event.preventDefault();
  void nextTick(() =>
    document.getElementById(`${id}-${active.value}`)?.scrollIntoView({ block: 'nearest' }),
  );
}
</script>
<template>
  <div
    class="branch-select"
    @keydown="keydown"
    @focusout="focusout"
  >
    <button
      ref="trigger"
      class="branch-trigger"
      type="button"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="id"
      @click="toggle"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M6 5v10m0-5h5a4 4 0 004-4"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <circle
          cx="6"
          cy="4"
          r="2"
          stroke="currentColor"
        />
        <circle
          cx="6"
          cy="16"
          r="2"
          stroke="currentColor"
        />
        <circle
          cx="15"
          cy="4"
          r="2"
          stroke="currentColor"
        />
      </svg>
      <span :title="selected">{{
        branches.find((branch) => branch.revision === selected)?.name || selected || '选择分支'
      }}</span><span
        class="arrow"
        aria-hidden="true"
      >⌄</span>
    </button>
    <div
      v-if="open"
      class="branch-popover"
    >
      <input
        ref="search"
        v-model="search"
        type="search"
        role="combobox"
        :aria-label="`${label}搜索`"
        :aria-controls="id"
        aria-expanded="true"
        :aria-activedescendant="`${id}-${active}`"
        placeholder="Search refs…"
        autocomplete="off"
      >
      <div
        :id="id"
        class="branch-options"
        role="listbox"
        :aria-label="label"
      >
        <button
          v-for="(branch, index) in filtered"
          :id="`${id}-${index}`"
          :key="branch.revision"
          type="button"
          role="option"
          :aria-selected="branch.revision === selected"
          :title="branch.name"
          :class="{ active: active === index }"
          @mouseenter="active = index"
          @click="pick(branch)"
        >
          <span class="branch-name">{{ branch.name }}</span>
          <small v-if="branch.current">current</small>
        </button>
        <p
          v-if="!filtered.length"
          class="muted"
        >
          没有匹配的分支
        </p>
      </div>
    </div>
  </div>
</template>
<style scoped lang="less">
.branch-select {
  position: relative;
  min-width: 0;
}
.branch-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.6em;
  text-align: left;
  height: 2.7em;
  padding: 0.5em 0.65em;
  border: 1px solid var(--ws-line);
  background: var(--ws-surface);
}
.branch-trigger > span:not(.arrow) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
svg {
  flex-shrink: 0;
}
.arrow {
  border-left: 1px solid var(--ws-line);
  padding-left: 0.6em;
}
.branch-popover {
  position: absolute;
  top: calc(100% + 0.4em);
  left: 0;
  right: 0;
  z-index: 5;
  min-width: 18em;
  padding: 0.7em;
  border: 1px solid var(--ws-line);
  border-radius: 0.6em;
  background: var(--ws-surface);
  box-shadow: 0 0.5em 2em #242a3420;
}
.branch-popover input {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--ws-blue);
  border-radius: 0;
  margin-bottom: 0.5em;
}
.branch-options {
  max-height: 18em;
  overflow: auto;
}
.branch-options button {
  display: flex;
  align-items: center;
  gap: 0.7em;
  width: 100%;
  padding: 0.55em;
  text-align: left;
}
.branch-options button.active,
[aria-selected='true'] {
  background: var(--ws-active);
}
.branch-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
small {
  color: var(--ws-muted);
  font-size: 0.8em;
}
p {
  padding: 1em 0.5em;
}
</style>
