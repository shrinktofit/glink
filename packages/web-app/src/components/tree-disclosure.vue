<script setup lang="ts">
defineProps<{ expanded?: boolean }>();
</script>

<template>
  <span
    class="tree-disclosure"
    :class="{ expanded }"
    aria-hidden="true"
  >
    <svg
      viewBox="0 0 16 16"
      focusable="false"
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  </span>
</template>

<style scoped lang="less">
.tree-disclosure {
  --disclosure-rotation: 0deg;
  display: inline-block;
  width: 1em;
  line-height: inherit;
  flex: 0 0 1em;
  color: var(--muted);
  &.expanded { --disclosure-rotation: 90deg; }
}
svg {
  display: inline-block;
  width: 1em;
  height: 1em;
  // Inline middle follows the font baseline and x-height rather than the line-box center.
  vertical-align: middle;
  transform: rotate(var(--disclosure-rotation));
}
path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
