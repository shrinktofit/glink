<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { GitRevisionKind, type GitReferenceOption, type GitRevision } from '@glink/protocol/git';
import {
  BaselineRefState,
  type BaselineRefComparison,
  type ProjectBaseline,
} from '@glink/protocol/workspace';
import GitRefSelect from '../git/git-ref-select.vue';

const props = defineProps<{
  references: readonly GitReferenceOption[];
  compare: (baseline: ProjectBaseline & { ref: string }, signal: AbortSignal)
  => Promise<BaselineRefComparison>;
  disabled?: boolean;
  tooltipContainer?: HTMLElement;
}>();
const baseline = defineModel<ProjectBaseline>();
const emit = defineEmits<{ validity: [valid: boolean] }>();
const selection = ref<GitRevision>({
  kind: baseline.value?.ref
    ? baseline.value.ref.startsWith('refs/tags/') ? GitRevisionKind.tag : GitRevisionKind.branch
    : GitRevisionKind.commit,
  revision: baseline.value?.ref ?? baseline.value?.commit ?? '',
});
const comparison = ref<BaselineRefComparison>();
const pending = ref(false);
const error = ref('');
let controller: AbortController | undefined;

const valid = computed(() => !pending.value && (selection.value.kind === GitRevisionKind.commit
  ? !selection.value.revision || /^[a-f0-9]{4,64}$/i.test(selection.value.revision)
  : !!baseline.value?.ref && selection.value.revision === baseline.value.ref));
watch(valid, (value) => emit('validity', value), { immediate: true });

const changed = computed(() => comparison.value?.state === BaselineRefState.available
  && comparison.value.commit !== baseline.value?.commit);
const tooltip = computed(() => {
  const result = comparison.value;
  const name = selection.value.revision.replace(/^refs\/(heads|remotes|tags)\//, '');
  if (result?.state === BaselineRefState.missing) {
    return `引用 ${name} 不存在，已保存的基线提交仍然保留。`;
  }
  if (result?.state !== BaselineRefState.available) {
    return '';
  }
  const { aheadCount: ahead, behindCount: behind } = result;
  const relation = ahead && behind
    ? `已分叉：基线领先 ${ahead} 个提交、落后 ${behind} 个提交`
    : ahead
      ? `基线领先 ${name} ${ahead} 个提交`
      : `基线落后 ${name} ${behind} 个提交`;
  return `${relation}。同步至 ${result.commit.slice(0, 12)}，保存后生效。`;
});

async function check(value: ProjectBaseline & { ref: string }, selecting = false) {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  pending.value = true;
  comparison.value = undefined;
  error.value = '';
  try {
    const result = await props.compare(value, request.signal);
    if (request.signal.aborted) {
      return;
    }
    comparison.value = result;
    if (selecting && result.state === BaselineRefState.available) {
      baseline.value = { commit: result.commit, ref: value.ref };
      comparison.value = { ...result, aheadCount: 0, behindCount: 0 };
    }
  } catch (cause: unknown) {
    if (!request.signal.aborted) {
      error.value = `无法检查基线引用：${cause instanceof Error ? cause.message : String(cause)}`;
    }
  } finally {
    if (controller === request) {
      pending.value = false;
    }
  }
}

function select(value: GitRevision) {
  controller?.abort();
  pending.value = false;
  const revision = value.kind === GitRevisionKind.commit
    && selection.value.kind !== GitRevisionKind.commit
    ? baseline.value?.commit ?? value.revision
    : value.revision;
  selection.value = { ...value, revision };
  comparison.value = undefined;
  error.value = '';
  if (value.kind === GitRevisionKind.commit) {
    baseline.value = revision ? { commit: revision } : undefined;
    return;
  }
  baseline.value = undefined;
  const option = props.references.find((entry) => entry.ref === value.revision);
  if (option) {
    void check({ commit: option.commit, ref: option.ref }, true);
  }
}

function synchronize() {
  if (comparison.value?.state === BaselineRefState.available && baseline.value?.ref) {
    baseline.value = { commit: comparison.value.commit, ref: baseline.value.ref };
    comparison.value = { ...comparison.value, aheadCount: 0, behindCount: 0 };
  }
}

onMounted(() => {
  if (baseline.value?.ref) {
    void check({ commit: baseline.value.commit, ref: baseline.value.ref });
  }
});
onUnmounted(() => controller?.abort());
</script>

<template>
  <div class="baseline-editor">
    <git-ref-select
      :model-value="selection"
      :references="references"
      :disabled="disabled"
      label="基线"
      optional
      @update:model-value="select"
    >
      <template #actions>
        <v-progress-circular
          v-if="pending"
          indeterminate
          :size="18"
          :width="2"
          aria-label="正在检查基线引用"
        />
        <v-tooltip
          v-else-if="changed || comparison?.state === BaselineRefState.missing"
          :text="tooltip"
          :attach="tooltipContainer ?? true"
          location="top"
        >
          <template #activator="{ props: tooltipProps }">
            <button
              v-if="changed"
              v-bind="tooltipProps"
              type="button"
              class="baseline-action ws-icon"
              aria-label="同步基线"
              :disabled="disabled"
              @click="synchronize"
            >
              <svg
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M16 8a6 6 0 0 0-10-3L3 8m0-5v5h5M4 12a6 6 0 0 0 10 3l3-3m0 5v-5h-5"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <span
              v-else
              v-bind="tooltipProps"
              class="baseline-warning"
              tabindex="0"
              role="img"
              aria-label="基线引用不存在"
            >
              <svg
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="m10 2 8 15H2L10 2Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                />
                <path
                  d="M10 7v5m0 2v.5"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </span>
          </template>
        </v-tooltip>
      </template>
    </git-ref-select>
    <p
      v-if="error"
      class="ws-error"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>

<style scoped lang="less">
.baseline-action,
.baseline-warning {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2em;
  height: 2em;
}
.baseline-action { color: var(--ws-blue); }
.baseline-warning { color: var(--ws-orange); }
svg { width: 1.35em; height: 1.35em; }
</style>
