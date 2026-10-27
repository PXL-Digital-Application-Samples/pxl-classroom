<!--
  A row's last commit: how long ago (the date on hover), then its SHA linking to
  the commit, the message on hover. The Progress table's cell, shared with the
  Teams table. What "last commit" means is lib/last-commit.js.
-->
<template>
  <div class="last-commit">
    <template v-if="row?.repo_url && sha">
      <div v-if="time" class="commit-time-top" :title="formatDate(time, timezone)">
        {{ formatRelative(time) }}
      </div>
      <a :href="`${row.repo_url}/commit/${sha}`" target="_blank" rel="noopener" class="mono sha" :title="message || null">
        {{ sha.slice(0, 7) }}
      </a>
    </template>
    <span v-else-if="notRead" class="text-muted" :title="NOT_READ_TITLE" data-not-read>not read yet</span>
    <span v-else-if="row?.repo_url" class="text-muted">no commits</span>
    <span v-else class="text-muted">-</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { formatDate, formatRelative } from '../lib/format.js'
import { latestSha, commitTime, commitMsg, commitsNotRead, NOT_READ_TITLE } from '../lib/last-commit.js'

const props = defineProps({
  /** A report row: a student's, or lib/last-commit.js `teamCommitRow`. */
  row: { type: Object, default: null },
  /** The assignment's timezone, for the date on hover. */
  timezone: { type: String, default: null },
})

const sha = computed(() => latestSha(props.row))
const time = computed(() => commitTime(props.row))
const message = computed(() => commitMsg(props.row))
const notRead = computed(() => commitsNotRead(props.row))
</script>

<style scoped>
.last-commit { white-space: nowrap; }
.commit-time-top {
  font-size: 0.85rem;
  color: var(--text-primary);
  margin-bottom: 2px;
}
.sha { display: inline-block; font-size: 0.8rem; }
</style>
