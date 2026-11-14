<script setup lang="ts">
import { computed, inject, onWatcherCleanup, ref, watch } from 'vue';
import { commitGraphLimit, type GitCommit, type GitReference } from '@glink/protocol/git';
import { gitRepoServiceKey } from '../../git/git-repo-service';

const props = withDefaults(defineProps<{
  maxCommits?: number;
  refreshKey?: number;
  references?: GitReference[];
}>(), {
  maxCommits: commitGraphLimit,
  refreshKey: 0,
  references: () => [],
});
const selected = defineModel<string>();
const emit = defineEmits<{ select: [commit: GitCommit]; loaded: [commits: GitCommit[]] }>();

function selectCommit(commit: GitCommit) {
  selected.value = commit.sha;
  emit('select', commit);
}

const repo = inject(gitRepoServiceKey);
if (!repo) {
  throw new Error('GitRepoService must be provided.');
}
const commits = ref<GitCommit[]>([]);
const loading = ref(true);
const errorMessage = ref('');

watch(() => [props.maxCommits, props.refreshKey], async ([maxCommits]) => {
  const controller = new AbortController();
  onWatcherCleanup(() => controller.abort());
  loading.value = true;
  errorMessage.value = '';
  commits.value = [];
  try {
    const result = await repo.getCommitGraph(maxCommits, controller.signal);
    if (!controller.signal.aborted) {
      commits.value = result.commits;
      emit('loaded', result.commits);
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!controller.signal.aborted) {
      loading.value = false;
    }
  }
}, { immediate: true });

const colors = [
  '#e5a100',
  '#a071d3',
  '#2da68b',
  '#e68a34',
  '#df6578',
  '#4a9bc6',
];
const referencesBySha = computed(() => {
  const map = new Map<string, GitReference[]>();
  for (const reference of props.references) {
    const group = map.get(reference.sha) ?? [];
    group.push(reference);
    map.set(reference.sha, group);
  }
  return map;
});
const rowHeight = 1.8;
const graph = computed(() => {
  let lanes: Array<{ sha: string; color: string }> = [];
  let colorIndex = 0;
  let columns = 1;
  const rows = commits.value.map((commit) => {
    const before = [...lanes];
    let lane = lanes.findIndex((entry) => entry.sha === commit.sha);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push({ sha: commit.sha, color: colors[colorIndex++ % colors.length] });
    }
    const color = lanes[lane].color;
    const next = lanes.filter((entry) => entry.sha !== commit.sha);
    commit.parents.forEach((sha, index) => {
      if (!next.some((entry) => entry.sha === sha)) {
        next.splice(Math.min(lane + index, next.length), 0, {
          sha,
          color: index === 0 ? color : colors[colorIndex++ % colors.length],
        });
      }
    });
    const paths: Array<{ d: string; color: string }> = [];
    before.forEach((entry, index) => {
      const x = 1 + index;
      if (entry.sha === commit.sha) {
        paths.push({ d: `M ${x} 0 V ${rowHeight / 2}`, color: entry.color });
      } else {
        const target = next.findIndex((candidate) => candidate.sha === entry.sha);
        const targetX = 1 + target;
        paths.push({
          d: `M ${x} 0 C ${x} ${rowHeight / 2}, ${targetX} ${rowHeight / 2}, ${targetX} ${rowHeight}`,
          color: entry.color,
        });
      }
    });
    commit.parents.forEach((sha) => {
      const target = next.findIndex((entry) => entry.sha === sha);
      const x = 1 + lane;
      const targetX = 1 + target;
      paths.push({
        d: `M ${x} ${rowHeight / 2} C ${x} ${rowHeight * 0.75}, ${targetX} ${rowHeight * 0.75}, ${targetX} ${rowHeight}`,
        color: next[target].color,
      });
    });
    columns = Math.max(columns, lanes.length, next.length);
    lanes = next;
    return {
      commit,
      x: 1 + lane,
      color,
      paths,
    };
  });
  return { rows, width: columns + 1 };
});
</script>

<template>
  <section
    class="commit-graph"
    :aria-busy="loading"
    aria-label="Commit history"
    :style="{ '--row-height': `${rowHeight}em` }"
  >
    <p
      v-if="loading"
      class="status"
      role="status"
    >
      Loading…
    </p>
    <p
      v-else-if="errorMessage"
      class="status error"
      role="alert"
    >
      {{ errorMessage }}
    </p>
    <p
      v-else-if="!commits.length"
      class="status"
    >
      No commits
    </p>
    <div
      v-else
      class="history"
    >
      <table aria-label="Commits">
        <tbody>
          <tr
            v-for="row in graph.rows"
            :key="row.commit.sha"
            :class="{ selected: selected === row.commit.sha }"
            :aria-selected="selected === row.commit.sha"
            tabindex="0"
            @click="selectCommit(row.commit)"
            @keydown.enter.prevent="selectCommit(row.commit)"
            @keydown.space.prevent="selectCommit(row.commit)"
          >
            <td class="topology">
              <svg
                :width="`${graph.width}em`"
                :height="`${rowHeight}em`"
                :viewBox="`0 0 ${graph.width} ${rowHeight}`"
                aria-hidden="true"
              >
                <path
                  v-for="(path, index) in row.paths"
                  :key="index"
                  :d="path.d"
                  :stroke="path.color"
                  fill="none"
                  stroke-width="0.1"
                />
                <circle
                  :cx="row.x"
                  :cy="rowHeight / 2"
                  r="0.2"
                  :fill="row.color"
                />
              </svg>
            </td>
            <td
              class="subject"
              :title="row.commit.subject"
            >
              <span
                v-for="reference in referencesBySha.get(row.commit.sha)"
                :key="reference.name"
                class="reference"
                :class="{ current: reference.current }"
              >{{ reference.current ? '✓ ' : '' }}{{ reference.name }}</span>
              {{ row.commit.subject }}
            </td>
            <td class="author">
              {{ row.commit.author }}
            </td>
            <td class="date">
              <time :datetime="row.commit.authoredAt">
                {{ row.commit.authoredAt.slice(0, 10) }}
              </time>
            </td>
            <td
              class="sha"
              :title="row.commit.sha"
            >
              {{ row.commit.sha.slice(0, 8) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped lang="less">
.commit-graph {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  color: var(--text);
  font-size: 0.875rem;

}

.history {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 .35em;
}

table {
  width: 100%;
  border-collapse: collapse;
  white-space: nowrap;
}

tr:hover { background: var(--hover); }
tr { cursor: pointer; }
tr.selected { background: var(--selected); }
tr:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

td {
  height: var(--row-height);
  line-height: var(--row-height);
  padding: 0 .65em;
}

.topology {
  width: 1%;
  padding: 0;

  svg { display: block; }
}

.subject {
  width: 100%;
  max-width: 0;
  min-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.reference { display: inline-block;
  max-width: 22em;
  margin-right: .4em;
  padding: 0 .25em;
  border: 1px solid #e3b841;
  border-radius: .2em;
  font-size: .85em;
  line-height: 1.35;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  }
.reference.current { background: #fff5cf; font-weight: 600; }
.author, .date { color: var(--muted); }
.sha { color: var(--text); font-family: Consolas, monospace; }
.status { padding: 1em; color: var(--muted); }
.error { color: var(--error); }
</style>
