<template>
  <div class="container fade-in" style="padding-top: var(--space-xl)">
    <div class="flex items-center gap-md" style="margin-bottom: var(--space-lg)">
      <router-link :to="{ name: 'dashboard', params: { org } }" class="btn">← Back to Dashboard</router-link>
      <h2>Admin Panel: {{ org }}</h2>
    </div>

    <div class="card" style="margin-bottom: var(--space-xl)">
      <h3>Create New Assignment</h3>
      <p class="text-secondary" style="margin-bottom: var(--space-md)">
        Automatically generates and commits the YAML file directly to your control repository.
      </p>
      <div class="form-grid">
        <div>
          <label>Assignment ID (slug)</label>
          <input type="text" v-model="form.id" placeholder="e.g. automation-pe-1" class="form-input" />
        </div>
        <div>
          <label>Title</label>
          <input type="text" v-model="form.title" placeholder="Automation Practice 1" class="form-input" />
        </div>
        <div>
          <label>Max Acceptances</label>
          <input type="number" v-model="form.max" placeholder="250" class="form-input" />
        </div>
        <div>
          <label>Opens At (ISO)</label>
          <input type="text" v-model="form.opens" placeholder="2026-06-01T08:00:00Z" class="form-input" />
        </div>
        <div>
          <label>Deadline (ISO)</label>
          <input type="text" v-model="form.deadline" placeholder="2026-06-15T23:59:00Z" class="form-input" />
        </div>
      </div>
      <div v-if="!previewMode">
        <button class="btn btn-primary" @click="previewYaml" style="margin-top: var(--space-md)">
          Preview YAML
        </button>
      </div>
      <div v-else class="yaml-preview" style="margin-top: var(--space-md)">
        <h4 style="margin-bottom: var(--space-xs)">YAML Preview</h4>
        <pre class="yaml-code"><code>{{ generatedYaml }}</code></pre>
        <div class="flex gap-sm" style="margin-top: var(--space-md)">
          <button class="btn btn-success" @click="createAssignment" :disabled="creating">
            {{ creating ? 'Committing...' : 'Confirm & Commit' }}
          </button>
          <button class="btn" @click="previewMode = false" :disabled="creating">Cancel</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: var(--space-xl)">
      <h3>Publish Assignment</h3>
      <p class="text-secondary" style="margin-bottom: var(--space-md)">
        Triggers the GitHub Actions workflow to create the public Broker Repository for an assignment.
      </p>
      <div class="form-grid">
        <div>
          <label>Assignment ID</label>
          <input type="text" v-model="pubForm.assignment" placeholder="e.g. automation-pe-1" class="form-input" />
        </div>
      </div>
      <button class="btn btn-primary" @click="publishAssignment" :disabled="publishing" style="margin-top: var(--space-md)">
        {{ publishing ? 'Triggering...' : 'Run Publish Workflow' }}
      </button>
    </div>
    
    <div class="card" style="margin-bottom: var(--space-xl)">
      <h3>Grant Deadline Extension</h3>
      <p class="text-secondary" style="margin-bottom: var(--space-md)">
        Generates an override JSON file granting a specific student extra time.
      </p>
      <div class="form-grid">
        <div>
          <label>Assignment ID</label>
          <input type="text" v-model="extForm.assignment" placeholder="e.g. automation-pe-1" class="form-input" />
        </div>
        <div>
          <label>Student GitHub Login</label>
          <input type="text" v-model="extForm.login" placeholder="e.g. octocat" class="form-input" />
        </div>
        <div>
          <label>New Deadline (ISO)</label>
          <input type="text" v-model="extForm.deadline" placeholder="2026-06-20T23:59:00Z" class="form-input" />
        </div>
      </div>
      <button class="btn btn-primary" @click="grantExtension" :disabled="extending" style="margin-top: var(--space-md)">
        {{ extending ? 'Granting...' : 'Grant Extension' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { config } from '../lib/config.js'
import { getToken } from '../lib/auth.js'
import { commitFile, triggerWorkflow } from '../lib/api.js'
import { parse } from 'yaml'
import { validateAgainst } from '../lib/validate.js'
import { toast } from '../lib/toast.js'

const props = defineProps(['org'])

const form = ref({
  id: '',
  title: '',
  max: 250,
  opens: new Date().toISOString().slice(0, 19) + 'Z',
  deadline: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 19) + 'Z',
})

const pubForm = ref({
  assignment: '',
})

const extForm = ref({
  assignment: '',
  login: '',
  deadline: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 19) + 'Z',
})

const creating = ref(false)
const publishing = ref(false)
const extending = ref(false)
const previewMode = ref(false)

const generatedYaml = computed(() => `schema_version: 1
title: "${form.value.title}"
description: "Created via Admin UI"
state: "published"
opens_at: "${form.value.opens}"
deadline_at: "${form.value.deadline}"
max_acceptances: ${form.value.max}
repository_name_pattern: "${form.value.id}-{github_login}"
`)

async function previewYaml() {
  if (!form.value.id || !form.value.title) {
    toast.error('Missing ID or Title')
    return
  }
  const doc = parse(generatedYaml.value)
  const { valid, errors } = await validateAgainst('assignment', doc)
  if (!valid) {
    toast.error('Validation failed: ' + errors.map(e => `${e.instancePath} ${e.message}`).join('; '))
    return
  }
  previewMode.value = true
}

async function createAssignment() {
  creating.value = true
  const token = getToken()
  const path = `assignments/${form.value.id}.yml`
  const res = await commitFile(token, props.org, config.controlRepo, path, generatedYaml.value, `Create assignment ${form.value.id}`)
  
  if (res.ok) {
    toast.success('Assignment YAML created successfully!')
    form.value.id = ''
    form.value.title = ''
    previewMode.value = false
  } else {
    toast.error(`Failed to create assignment: ${res.data?.message || 'Unknown error'}`)
  }
  creating.value = false
}

async function publishAssignment() {
  if (!pubForm.value.assignment) {
    toast.error('Missing Assignment ID')
    return
  }
  publishing.value = true
  const token = getToken()
  const res = await triggerWorkflow(token, 'PXL-Digital-Application-Samples', 'pxl-classroom', 'publish-assignment.yml', { org: props.org, assignment_id: pubForm.value.assignment })
  if (res.ok || res.status === 204) {
    toast.success('Publish workflow triggered! Check GitHub Actions in pxl-classroom repository.')
    pubForm.value.assignment = ''
  } else {
    toast.error(`Failed to trigger workflow: ${res.data?.message || 'Unknown error'}`)
  }
  publishing.value = false
}

async function grantExtension() {
  if (!extForm.value.assignment || !extForm.value.login) {
    toast.error('Missing Assignment ID or Login')
    return
  }
  extending.value = true
  const token = getToken()
  const overrideDoc = {
    schema_version: 1,
    assignment_id: extForm.value.assignment,
    github_login: extForm.value.login,
    deadline_at: extForm.value.deadline,
    reason: "Extension granted via Admin UI"
  }
  
  const { valid, errors } = await validateAgainst('override', overrideDoc)
  if (!valid) {
    toast.error('Validation failed: ' + errors.map(e => `${e.instancePath} ${e.message}`).join('; '))
    extending.value = false
    return
  }

  const jsonStr = JSON.stringify(overrideDoc, null, 2) + '\n'
  const path = `overrides/${extForm.value.assignment}/${extForm.value.login}.json`
  const res = await commitFile(token, props.org, config.controlRepo, path, jsonStr, `Grant extension to ${extForm.value.login}`)
  
  if (res.ok) {
    toast.success('Extension granted successfully!')
    extForm.value.login = ''
  } else {
    toast.error(`Failed to grant extension: ${res.data?.message || 'Unknown error'}`)
  }
  extending.value = false
}
</script>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
  margin-top: var(--space-sm);
}
.form-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: inherit;
  margin-top: 4px;
}
.form-input:focus {
  outline: 2px solid var(--accent-blue);
  border-color: transparent;
}
label {
  font-weight: 500;
  font-size: 0.9rem;
  color: var(--text-secondary);
}
.yaml-code {
  background: var(--bg-tertiary);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 0.875rem;
  color: var(--accent-blue);
  overflow-x: auto;
  border: 1px solid var(--border-muted);
}
@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>
