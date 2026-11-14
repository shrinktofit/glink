<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';

const props = withDefaults(defineProps<{ vertical?: boolean; min?: number; max?: number }>(), {
  vertical: false,
  min: 0.15,
  max: 0.85,
});
const ratio = defineModel<number>({ default: 0.5 });
const container = useTemplateRef<HTMLDivElement>('container');
const dragging = ref(false);
const layout = computed(() => ({
  [props.vertical ? 'gridTemplateRows' : 'gridTemplateColumns']:
    `minmax(0, ${ratio.value}fr) 1px minmax(0, ${1 - ratio.value}fr)`,
}));

function drag(event: PointerEvent) {
  if (!dragging.value) {
    return;
  }
  const bounds = container.value!.getBoundingClientRect();
  const fraction = props.vertical
    ? (event.clientY - bounds.top) / bounds.height
    : (event.clientX - bounds.left) / bounds.width;
  ratio.value = Math.min(props.max, Math.max(props.min, fraction));
}

function start(event: PointerEvent) {
  if (event.button !== 0) {
    return;
  }
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function resizeWithKey(event: KeyboardEvent) {
  const decrease = props.vertical ? 'ArrowUp' : 'ArrowLeft';
  const increase = props.vertical ? 'ArrowDown' : 'ArrowRight';
  if (event.key === decrease || event.key === increase) {
    ratio.value = Math.min(props.max, Math.max(props.min,
      ratio.value + (event.key === increase ? 0.02 : -0.02)));
  } else if (event.key === 'Home') {
    ratio.value = props.min;
  } else if (event.key === 'End') {
    ratio.value = props.max;
  } else {
    return;
  }
  event.preventDefault();
}
</script>

<template>
  <div
    ref="container"
    class="split-pane"
    :class="{ vertical, dragging }"
    :style="layout"
  >
    <div class="pane">
      <slot name="first" />
    </div>
    <div
      class="separator"
      role="separator"
      tabindex="0"
      :aria-orientation="vertical ? 'horizontal' : 'vertical'"
      :aria-valuenow="Math.round(ratio * 100)"
      :aria-valuemin="Math.round(min * 100)"
      :aria-valuemax="Math.round(max * 100)"
      aria-label="Resize panels"
      @pointerdown="start"
      @pointermove="drag"
      @pointerup="dragging = false"
      @pointercancel="dragging = false"
      @lostpointercapture="dragging = false"
      @keydown="resizeWithKey"
    />
    <div class="pane">
      <slot name="second" />
    </div>
  </div>
</template>

<style scoped lang="less">
.split-pane { display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  }
.pane { min-width: 0; min-height: 0; overflow: hidden; }
.separator {
  position: relative;
  z-index: 2;
  background: var(--divider);
  cursor: col-resize;
  touch-action: none;
  &::after { content: ''; position: absolute; inset: 0 -4px; }
  &:focus-visible { background: var(--accent); outline: 1px solid var(--accent); }
}
.vertical > .separator {
  cursor: row-resize;
  &::after { inset: -4px 0; }
}
.dragging { user-select: none; }
</style>
