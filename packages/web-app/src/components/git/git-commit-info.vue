<script setup lang="ts">
import { computed } from 'vue';
import type { GitCommitDetail } from '@glink/protocol/git';

const props = defineProps<{ commit: GitCommitDetail; compact?: boolean }>();
const description = computed(() => props.commit.message.split('\n').slice(1).join('\n').trim());
</script>

<template>
  <div
    class="commit-info"
    :class="{ compact }"
  >
    <template v-if="compact">
      <span
        class="author"
        :title="commit.authorEmail"
      >{{ commit.author }}</span>
      <code :title="commit.sha">{{ commit.sha.slice(0, 8) }}</code>
      <time :datetime="commit.authoredAt">{{ new Date(commit.authoredAt).toLocaleString() }}</time>
      <strong :title="commit.message">{{ commit.subject }}</strong>
    </template>
    <template v-else>
      <h2>{{ commit.subject }}</h2>
      <p
        v-if="description"
        class="description"
      >
        {{ description }}
      </p>
      <dl>
        <dt>Author</dt><dd>{{ commit.author }} &lt;{{ commit.authorEmail }}&gt;</dd>
        <dt>Date</dt><dd>{{ new Date(commit.authoredAt).toLocaleString() }}</dd>
        <dt>Commit</dt><dd><code>{{ commit.sha }}</code></dd>
        <dt>Parents</dt><dd>
          <code
            v-for="parent in commit.parents"
            :key="parent"
          >{{ parent }}</code>
        </dd>
      </dl>
    </template>
  </div>
</template>

<style scoped lang="less">
.commit-info { padding: 1em; font-size: .875rem; overflow: auto; height: 100%; }
h2 { font-size: 1em; font-weight: 600; }
.description { margin: 1em 0; white-space: pre-wrap; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .7em 1em; margin-top: 1em; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
dd code { display: block; }
.compact {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: .6em;
  height: 2em;
  padding: 0 .7em;
  border-bottom: 1px solid var(--divider);
  white-space: nowrap;
  overflow: hidden;
  font-size: .8125rem;
  time, code { color: var(--muted); }
  strong { overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
}
</style>
