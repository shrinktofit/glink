<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue';
import type { GitReferenceOption } from '@glink/protocol/git';
const props = defineProps<{
  references: readonly GitReferenceOption[];
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
  props.references.filter((reference) =>
    reference.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
  ),
);
watch(search, () => {
  active.value = 0;
});
watch(() => props.disabled, (disabled) => {
  if (disabled) {
    open.value = false;
  }
});

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    search.value = '';
    active.value = Math.max(
      0,
      props.references.findIndex((reference) => reference.ref === selected.value),
    );
    await nextTick();
    searchInput.value!.focus();
  }
}

function pick(reference: GitReferenceOption) {
  selected.value = reference.ref;
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
    class="reference-select"
    @keydown="keydown"
    @focusout="focusout"
  >
    <button
      ref="trigger"
      class="reference-trigger"
      type="button"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="id"
      @click="toggle"
    >
      <svg
        v-if="!selected.startsWith('refs/tags/')"
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
      <svg
        v-else
        width="16"
        height="16"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3 3h7l7 7-7 7-7-7V3Z"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <circle
          cx="7"
          cy="7"
          r="1.4"
          stroke="currentColor"
        />
      </svg>
      <span :title="selected">{{
        references.find((reference) => reference.ref === selected)?.name
          || selected.replace(/^refs\/(heads|remotes|tags)\//, '') || '选择引用'
      }}</span><span
        class="arrow"
        aria-hidden="true"
      >⌄</span>
    </button>
    <div
      v-if="open"
      class="reference-popover"
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
        class="reference-options"
        role="listbox"
        :aria-label="label"
      >
        <button
          v-for="(reference, index) in filtered"
          :id="`${id}-${index}`"
          :key="reference.ref"
          type="button"
          role="option"
          :disabled="disabled"
          :aria-selected="reference.ref === selected"
          :title="reference.name"
          :class="{ active: active === index }"
          @mouseenter="active = index"
          @click="pick(reference)"
        >
          <span class="reference-name">{{ reference.name }}</span>
          <small v-if="reference.current">current</small>
        </button>
        <p
          v-if="!filtered.length"
          class="muted"
        >
          没有匹配的引用
        </p>
      </div>
    </div>
  </div>
</template>
<style scoped lang="less">
.reference-select {
  position: relative;
  min-width: 0;
}
.reference-trigger {
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
.reference-trigger > span:not(.arrow) {
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
.reference-popover {
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
.reference-popover input {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--ws-blue);
  border-radius: 0;
  margin-bottom: 0.5em;
}
.reference-options {
  max-height: 18em;
  overflow: auto;
}
.reference-options button {
  display: flex;
  align-items: center;
  gap: 0.7em;
  width: 100%;
  padding: 0.55em;
  text-align: left;
}
.reference-options button.active,
[aria-selected='true'] {
  background: var(--ws-active);
}
.reference-name {
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
