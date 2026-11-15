<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';
import { editor } from 'monaco-editor/editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
const props = defineProps<{ content: string }>();
const container = useTemplateRef<HTMLDivElement>('container');
let codeEditor: editor.IStandaloneCodeEditor | undefined;
let model: editor.ITextModel | undefined;
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
onMounted(() => {
  model = editor.createModel(props.content, 'plaintext');
  codeEditor = editor.create(container.value!, {
    model,
    readOnly: true,
    automaticLayout: true,
    theme: 'vs',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    padding: { top: 12 },
  });
});
watch(
  () => props.content,
  (content) => model?.setValue(content),
);
onBeforeUnmount(() => {
  codeEditor?.dispose();
  model?.dispose();
});
</script>
<template>
  <div
    ref="container"
    class="code-view"
    aria-label="File content"
  />
</template>
<style scoped lang="less">
.code-view {
  height: 100%;
  width: 100%;
  min-height: 0;
}
</style>
