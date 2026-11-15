<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';
import { diffLines } from 'diff';
import { editor, Range } from 'monaco-editor/editor';
import 'monaco-editor/features/diffEditor/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

const props = withDefaults(defineProps<{
  original: string;
  modified: string;
  language?: string;
}>(), { language: 'plaintext' });
const container = useTemplateRef<HTMLDivElement>('container');
let diffEditor: editor.IStandaloneDiffEditor | undefined;
let diffModel: editor.IDiffEditorViewModel | undefined;
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
    scrollBeyondLastLine: true,
    hideUnchangedRegions: { enabled: true },
    fontSize: 12,
    renderOverviewRuler: false,
    padding: { top: 12 },
  });
  originalModel = editor.createModel(props.original, props.language);
  modifiedModel = editor.createModel(props.modified, props.language);
  diffModel = diffEditor.createViewModel({ original: originalModel, modified: modifiedModel });
  diffEditor.setModel(diffModel);
});

function updateText(model: editor.ITextModel, text: string) {
  const current = model.getValue();
  if (current === text) {
    return;
  }
  const changes = diffLines(current, text);
  const edits: editor.IIdentifiedSingleEditOperation[] = [];
  let offset = 0;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      offset += change.value.length;
      continue;
    }
    const start = model.getPositionAt(offset);
    let replacement = '';
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      if (changes[index].removed) {
        offset += changes[index].value.length;
      } else {
        replacement += changes[index].value;
      }
      index++;
    }
    index--;
    edits.push({
      range: Range.fromPositions(start, model.getPositionAt(offset)),
      text: replacement,
    });
  }
  // Preserve decorations so Monaco can track expanded regions and cursors across edits.
  model.applyEdits(edits);
}

watch([() => props.original, () => props.modified], ([original, modified]) => {
  if (originalModel && modifiedModel) {
    updateText(originalModel, original);
    updateText(modifiedModel, modified);
  }
});
watch(() => props.language, (language) => {
  if (originalModel && modifiedModel) {
    editor.setModelLanguage(originalModel, language);
    editor.setModelLanguage(modifiedModel, language);
  }
});

onBeforeUnmount(() => {
  diffEditor?.dispose();
  diffModel?.dispose();
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
