<script setup lang="ts">
import { GitIndexAction } from '@glink/protocol/git';
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
const props = defineProps<{
  path: string;
  repoPath: string;
  x: number;
  y: number;
  indexAction?: GitIndexAction;
  indexDisabled?: boolean;
}>();
const emit = defineEmits<{ close: []; index: [] }>();
const menu = useTemplateRef<HTMLDivElement>('menu');
const position = ref({ left: '0px', top: '0px' });
const error = ref('');
const events = new AbortController();

async function place() {
  await nextTick();
  const bounds = menu.value!.getBoundingClientRect();
  position.value = {
    left: `${Math.max(4, Math.min(props.x, window.innerWidth - bounds.width - 4))}px`,
    top: `${Math.max(4, Math.min(props.y, window.innerHeight - bounds.height - 4))}px`,
  };
}

onMounted(() => {
  menu.value!.showPopover();
  void place();
  menu.value!.querySelector<HTMLButtonElement>('button:not(:disabled)')!.focus();
  window.addEventListener('resize', () => emit('close'), { signal: events.signal });
  document.addEventListener('scroll', () => emit('close'), {
    capture: true,
    signal: events.signal,
  });
});
watch(
  () => [props.x, props.y, props.path],
  () => {
    error.value = '';
    void place();
  },
);
onUnmounted(() => events.abort());

async function copy(absolute: boolean) {
  const path = absolute
    ? `${props.repoPath.replaceAll('\\', '/').replace(/\/$/, '')}/${props.path}`
    : props.path;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(path);
    } else {
      // LAN HTTP origins have no Clipboard API; keep copying available from the menu gesture.
      const input = document.createElement('textarea');
      input.value = path;
      input.readOnly = true;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      menu.value!.append(input);
      try {
        input.select();
        if (!document.execCommand('copy')) {
          throw new Error('浏览器未允许复制到剪贴板。');
        }
      } finally {
        input.remove();
      }
    }
    emit('close');
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function navigate(event: KeyboardEvent) {
  const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : buttons.length - 1;
    buttons[(index + offset) % buttons.length].focus();
  }
}
</script>
<template>
  <div
    ref="menu"
    class="git-file-menu command-menu"
    popover="auto"
    role="menu"
    aria-label="文件操作"
    :style="position"
    @toggle="$event.newState === 'closed' && emit('close')"
    @keydown="navigate"
  >
    <template v-if="indexAction">
      <button
        role="menuitem"
        :disabled="indexDisabled"
        :aria-disabled="indexDisabled || undefined"
        @click="!indexDisabled && emit('index')"
      >
        {{ indexAction === GitIndexAction.stage ? '暂存' : '取消暂存' }}
      </button>
      <hr role="separator">
    </template>
    <button
      role="menuitem"
      @click="copy(false)"
    >
      复制路径
    </button>
    <button
      role="menuitem"
      @click="copy(true)"
    >
      复制绝对路径
    </button>
    <p
      v-if="error"
      class="copy-error"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>
<style scoped lang="less">
.git-file-menu {
  position: fixed;
  inset: auto;
  margin: 0;
}
.copy-error {
  color: var(--ws-red, var(--error));
  padding: 0.5em;
  overflow-wrap: anywhere;
}
</style>
