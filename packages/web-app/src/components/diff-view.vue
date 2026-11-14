<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';
import { editor } from 'monaco-editor/editor';
import 'monaco-editor/features/diffEditor/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

const props = withDefaults(defineProps<{
  original: string;
  modified: string;
  language?: string;
}>(), { language: 'plaintext' });
const container = useTemplateRef<HTMLDivElement>('container');
let diffEditor: editor.IStandaloneDiffEditor | undefined;
let originalModel: editor.ITextModel | undefined;
let modifiedModel: editor.ITextModel | undefined;

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

onMounted(() => {
  diffEditor = editor.createDiffEditor(container.value!, {
    theme: 'vs',
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    hideUnchangedRegions: { enabled: true },
    fontSize: 12,
    renderOverviewRuler: false,
    padding: { top: 12 },
  });
  originalModel = editor.createModel(props.original, props.language);
  modifiedModel = editor.createModel(props.modified, props.language);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
});

watch(() => props.original, (text) => originalModel?.setValue(text));
watch(() => props.modified, (text) => modifiedModel?.setValue(text));
watch(() => props.language, (language) => {
  if (originalModel && modifiedModel) {
    editor.setModelLanguage(originalModel, language);
    editor.setModelLanguage(modifiedModel, language);
  }
});

onBeforeUnmount(() => {
  diffEditor?.dispose();
  originalModel?.dispose();
  modifiedModel?.dispose();
});
</script>

<template>
  <div
    ref="container"
    class="diff-view"
    aria-label="File diff"
  />
</template>

<style scoped lang="less">
.diff-view { width: 100%; height: 100%; min-height: 0; }
</style>
