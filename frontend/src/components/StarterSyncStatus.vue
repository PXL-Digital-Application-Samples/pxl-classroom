<template>
  <!-- Where the last starter sync stands. Read when the page opens and when
       the lecturer asks - never on a timer: the page must not spend requests
       on a question nobody is asking. The sentence comes from
       lib/sync-status.mjs, never from here. -->
  <section v-if="view" :class="['sync-status', 'diag-banner', `tone-${view.tone}`]" :data-state="view.state" aria-live="polite">
    <span :class="['status-dot', dotClass]"></span>
    <div class="sync-status-body">
      <!-- The sha in monospace (DESIGN.md §2), split out of the sentence the
           library wrote rather than a second sentence composed here. -->
      <strong>Starter code: <template v-for="(part, i) in titleParts" :key="i"><code v-if="part.code">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></strong>
      <p v-if="view.detail" class="text-muted text-sm">{{ view.detail }}</p>
      <ul v-if="view.failed.length" class="sync-status-failed text-sm">
        <li v-for="f in view.failed" :key="f.login"><code>@{{ f.login }}</code>: {{ f.error }}</li>
      </ul>
      <p class="sync-status-actions text-sm">
        <a v-if="view.runUrl" :href="view.runUrl" target="_blank" rel="noopener">View run</a>
        <button v-if="view.action === 'sync-again'" type="button" class="btn-link" @click="$emit('sync')">
          Sync again
        </button>
        <button
          v-if="view.action === 'refresh'"
          type="button"
          class="btn-link"
          :disabled="loading"
          @click="load"
        >
          {{ loading ? 'Checking…' : 'Check again' }}
        </button>
      </p>
    </div>
  </section>
  <section v-else-if="unreadable" class="sync-status diag-banner" data-state="unreadable">
    <span class="status-dot dot-neutral"></span>
    <div class="sync-status-body">
      <strong>Starter code: could not read the sync records.</strong>
      <p class="text-muted text-sm">
        This is not "no sync has run" - it is unknown.
        <button type="button" class="btn-link" :disabled="loading" @click="load">Try again</button>
      </p>
    </div>
  </section>
</template>

<script setup>
// The status of this assignment's starter syncs (ARCHITECTURE §11.7).
//
// Its own component, with its own reads, because it is its own question - the
// same shape as StudentActionsModal owning its form. Three reads at most: the
// `syncs/<id>/` listing and the newest record; the run that record names when
// it says `running`; the template's newest commit when it says it finished.
import { computed, onMounted, ref, watch } from 'vue'
import { ghApi, getRepoContent } from '../lib/api.js'
import { getToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { describeSyncStatus, newestSyncFile } from '../../../lib/sync-status.mjs'

const props = defineProps({
  org: { type: String, required: true },
  assignment: { type: Object, required: true },
  /** Bumped by the parent after a sync is dispatched, to read again. */
  refreshKey: { type: Number, default: 0 },
})
defineEmits(['sync'])

const view = ref(null)
const unreadable = ref(false)
const loading = ref(false)
let generation = 0

const titleParts = computed(() => {
  const { title = '', commit = '' } = view.value || {}
  const at = commit ? title.indexOf(commit) : -1
  if (at < 0) return [{ text: title }]
  return [
    { text: title.slice(0, at) },
    { text: commit, code: true },
    { text: title.slice(at + commit.length) },
  ]
})

const dotClass = computed(() => ({
  success: 'dot-success',
  warning: 'dot-warning',
  danger: 'dot-danger',
  neutral: 'dot-neutral',
})[view.value?.tone] || 'dot-neutral')

async function load() {
  const run = ++generation
  loading.value = true
  try {
    const token = getToken()
    const listing = await ghApi(token, 'GET', `/repos/${props.org}/${config.controlRepo}/contents/syncs/${props.assignment.id}`)
    if (run !== generation) return
    // No directory is an answer: nothing has ever been synced. Anything else
    // that is not a listing is a failed read, and says so.
    if (listing.status === 404) { view.value = null; unreadable.value = false; return }
    if (!listing.ok) { view.value = null; unreadable.value = true; return }
    const newest = newestSyncFile(listing.data)
    if (!newest) { view.value = null; unreadable.value = false; return }

    let record
    try {
      record = JSON.parse(await getRepoContent(token, props.org, config.controlRepo, newest.path))
    } catch {
      if (run === generation) { view.value = null; unreadable.value = true }
      return
    }

    let runInfo
    if ((record.status || 'completed') === 'running' && record.run_id) {
      const res = await ghApi(token, 'GET', `/repos/${config.hubOwner}/${config.hubRepo}/actions/runs/${record.run_id}`)
      runInfo = res.ok ? res.data : null
    }
    let templateHeadSha
    if ((record.status || 'completed') === 'completed' && props.assignment.template?.repository) {
      const owner = props.assignment.template.owner || props.org
      const res = await ghApi(token, 'GET', `/repos/${owner}/${props.assignment.template.repository}/commits?per_page=1`)
      templateHeadSha = res.ok && Array.isArray(res.data) && res.data[0]?.sha ? res.data[0].sha : null
    }
    if (run !== generation) return
    unreadable.value = false
    view.value = describeSyncStatus({ record, run: runInfo, templateHeadSha })
  } catch {
    if (run === generation) { view.value = null; unreadable.value = true }
  } finally {
    if (run === generation) loading.value = false
  }
}

onMounted(load)
watch(() => [props.refreshKey, props.assignment?.id], load)

defineExpose({ load })
</script>

<style scoped>
/* A tonal step off the canvas, no outline (DESIGN.md §1.1): --bg-surface sits
   above --bg-canvas in both themes, like the summary cards over it. */
.sync-status {
  margin-bottom: var(--space-md);
  background: var(--bg-surface);
}

/* Needs a look: tinted like the rejections notice. A quiet state stays a
   plain surface - a success is not news. */
.sync-status.tone-warning {
  background: var(--tint-attention-subtle);
}

.sync-status.tone-danger {
  background: var(--tint-danger-subtle);
}

/* Level with the first line of text, not the top of the box. */
.sync-status > .status-dot {
  margin-top: 7px;
}

.sync-status-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  min-width: 0;
}

.sync-status-body p {
  margin: 0;
}

.sync-status-failed {
  margin: 0;
  padding-left: var(--space-md);
}

.sync-status-actions {
  display: flex;
  gap: var(--space-md);
  align-items: center;
}
</style>
