<template>
  <div class="setup-page container fade-in">
    <header class="setup-header">
      <router-link to="/" class="btn btn-with-icon">
        <Icon name="arrow-left" :size="14" />
        <span>Home</span>
      </router-link>
      <h2>Central GitHub App setup</h2>
    </header>

    <!-- Conversion result: GitHub redirected back with ?code= -->
    <div v-if="converting" class="card setup-card">
      <div class="loading-inline"><div class="spinner sm"></div> Exchanging the manifest code for App credentials…</div>
    </div>

    <div v-else-if="credentials" class="card setup-card">
      <h3>App created: {{ credentials.name }}</h3>
      <p class="text-warning notice">
        These credentials are shown <strong>once</strong>. Store them as hub secrets now — this page cannot retrieve them again.
      </p>
      <dl class="cred-list">
        <div class="cred"><dt>App ID</dt><dd><code>{{ credentials.id }}</code></dd></div>
        <div class="cred"><dt>Client ID</dt><dd><code>{{ credentials.client_id }}</code></dd></div>
        <div class="cred">
          <dt>Private key</dt>
          <dd>
            <button class="btn btn-primary btn-with-icon" type="button" @click="downloadPem">
              <Icon name="download" :size="14" />
              <span>Download .pem</span>
            </button>
          </dd>
        </div>
      </dl>
      <h4>Finish the setup</h4>
      <ol class="steps">
        <li>
          In the hub repo (<code>{{ hubFullName }}</code>) → Settings → Secrets and variables → Actions, set:
          <ul>
            <li><code>PXL_APP_CLIENT_ID</code> — the Client ID above</li>
            <li><code>PXL_APP_PRIVATE_KEY</code> — the full PEM body, including the BEGIN/END lines</li>
            <li><code>VITE_GITHUB_CLIENT_ID</code> — same Client ID (wires the device flow at SPA build time)</li>
          </ul>
        </li>
        <li>
          On the App settings page, add the two permissions the manifest cannot carry:
          <ul>
            <li>Organization → <strong>Plan: Read-only</strong> (weekly usage report)</li>
            <li>Account → <strong>Starring: Read and write</strong> (students star the broker to accept)</li>
          </ul>
        </li>
        <li>Re-run the <code>deploy-frontend.yml</code> workflow so the SPA rebuilds with the client ID.</li>
        <li>Install the App per <a :href="`${runbookUrl}#14-install-the-app-on-the-hubs-owning-org-scoped-narrowly`" target="_blank" rel="noopener">RUNBOOK §1.4</a> (hub org, <em>only</em> the hub repo) and <a :href="`${runbookUrl}#21-install-the-app-on-the-new-org`" target="_blank" rel="noopener">§2.1</a> (each participating org, all repositories).</li>
      </ol>
    </div>

    <div v-else-if="conversionError" class="card setup-card">
      <h3>Could not retrieve the App credentials</h3>
      <p class="text-secondary">{{ conversionError }}</p>
      <p class="text-secondary">
        The manifest code is single-use and expires after one hour. If the App was created
        (check <a href="https://github.com/settings/apps" target="_blank" rel="noopener">your App settings</a>),
        you can collect everything manually: the <strong>App ID</strong> and <strong>Client ID</strong> are under
        "About" on the App's settings page, and a fresh private key comes from
        <strong>Generate a private key</strong> on that same page. Then follow the "Finish the setup" steps below.
      </p>
      <button class="btn" type="button" @click="conversionError = ''">Start over</button>
    </div>

    <!-- Default: the manifest form -->
    <div v-else class="card setup-card">
      <p class="text-secondary">
        One click registers the <strong>PXL Classroom Provisioner</strong> GitHub App from a manifest,
        with the repository permissions pre-filled ({{ permissionSummary }}) and device flow enabled.
        GitHub sends you back here afterwards to collect the App ID, Client ID, and private key.
      </p>

      <form :action="formAction" method="post">
        <input type="hidden" name="manifest" :value="manifest" />
        <div class="field">
          <label for="setup-org">Owner organization (recommended)</label>
          <input id="setup-org" v-model.trim="ownerOrg" placeholder="e.g. PXL-Digital-Application-Samples" />
          <small>
            Registers the App under this organization. Leave empty to register under your personal account
            (works, but ties the App's lifecycle to one person).
          </small>
        </div>
        <button type="submit" class="btn btn-primary btn-lg">Create GitHub App</button>
      </form>

      <details class="manual-details">
        <summary>What happens next / doing it manually</summary>
        <ol class="steps">
          <li>GitHub shows a confirmation page — click <strong>Create GitHub App for …</strong>.</li>
          <li>You are redirected back here; this page exchanges the one-time code and shows the App ID, Client ID, and private key.</li>
          <li>You store the three hub secrets (<code>PXL_APP_CLIENT_ID</code>, <code>PXL_APP_PRIVATE_KEY</code>, <code>VITE_GITHUB_CLIENT_ID</code>), add the two manual permissions (Organization <strong>Plan: Read</strong>, Account <strong>Starring: Read and write</strong>), and re-run <code>deploy-frontend.yml</code>.</li>
        </ol>
        <p class="text-secondary">Full procedure: <a :href="`${runbookUrl}#12-create-the-central-github-app`" target="_blank" rel="noopener">RUNBOOK §1.2–§1.4</a>.</p>
      </details>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '../components/Icon.vue'
import { config } from '../lib/config.js'
import { EXPECTED_APP_PERMISSIONS } from '../../../lib/audit.mjs'

const route = useRoute()

const ownerOrg = ref('')
const converting = ref(false)
const credentials = ref(null)
const conversionError = ref('')

const hubFullName = `${config.hubOwner}/${config.hubRepo}`
const runbookUrl = `https://github.com/${config.hubOwner}/${config.hubRepo}/blob/main/RUNBOOK.md`

// The URL where the frontend is hosted (used for homepage and redirect)
const hostUrl = computed(() => window.location.origin + import.meta.env.BASE_URL)

// Personal-account manifests post to /settings/apps/new; org-owned ones to
// /organizations/<org>/settings/apps/new. Same manifest either way.
const formAction = computed(() =>
  ownerOrg.value
    ? `https://github.com/organizations/${encodeURIComponent(ownerOrg.value)}/settings/apps/new`
    : 'https://github.com/settings/apps/new'
)

const permissionSummary = computed(() =>
  Object.entries(EXPECTED_APP_PERMISSIONS)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
)

const manifest = computed(() => {
  return JSON.stringify({
    name: 'PXL Classroom Provisioner',
    url: hostUrl.value,
    hook_attributes: {
      url: hostUrl.value,
    },
    // GitHub redirects here with a one-time ?code= we exchange below.
    redirect_url: `${hostUrl.value}setup`,
    public: true,
    default_permissions: { ...EXPECTED_APP_PERMISSIONS },
    default_events: [],
    request_oauth_on_install: true,
    setup_url: hostUrl.value,
    setup_on_update: false,
  })
})

// Exchange the one-time manifest code for the App's credentials.
// api.github.com sends CORS headers, and this endpoint needs no auth.
async function convertCode(code) {
  converting.value = true
  try {
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json' },
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      conversionError.value = `GitHub rejected the code (HTTP ${res.status}${data?.message ? `: ${data.message}` : ''}).`
      return
    }
    credentials.value = {
      id: data.id,
      name: data.name,
      client_id: data.client_id,
      pem: data.pem,
    }
  } catch (e) {
    conversionError.value = `Exchange failed: ${e.message}`
  } finally {
    converting.value = false
  }
}

function downloadPem() {
  if (!credentials.value?.pem) return
  const blob = new Blob([credentials.value.pem], { type: 'application/x-pem-file' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'pxl-classroom-provisioner.private-key.pem'
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(() => {
  const code = route.query.code
  if (code) {
    // Strip the single-use code from the URL so a refresh doesn't retry a
    // spent code and scare the user with an error.
    history.replaceState(null, '', `${import.meta.env.BASE_URL}setup`)
    convertCode(String(code))
  }
})
</script>

<style scoped>
.setup-page {
  padding-top: var(--space-xl);
  padding-bottom: var(--space-2xl);
  max-width: 720px;
}
.setup-header {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
}
.setup-header h2 { margin: 0; }
.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }

.setup-card { padding: var(--space-lg); }
.setup-card h3 { margin: 0 0 var(--space-md); }
.setup-card h4 { margin: var(--space-lg) 0 var(--space-sm); }
.setup-card p { margin: 0 0 var(--space-md); }

.text-secondary { color: var(--text-secondary); }
.text-warning { color: var(--accent-yellow); }
.notice {
  border: 1px solid var(--accent-yellow);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  font-size: 0.9rem;
}

.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--space-md); }
.field label { font-weight: 500; font-size: 0.9rem; color: var(--text-secondary); }
.field small { color: var(--text-muted); font-size: 0.8rem; }
.field input {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.95rem;
}

.cred-list { margin: 0 0 var(--space-md); }
.cred {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-sm) 0;
  border-bottom: 1px solid var(--border-muted);
}
.cred dt { width: 110px; flex-shrink: 0; color: var(--text-secondary); font-size: 0.9rem; }
.cred dd { margin: 0; }
.cred code {
  font-family: var(--font-mono);
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 4px;
}

.steps { margin: var(--space-sm) 0; padding-left: var(--space-lg); }
.steps li { margin-bottom: var(--space-sm); color: var(--text-secondary); }
.steps ul { margin: var(--space-xs) 0; padding-left: var(--space-md); }
.steps code { background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px; font-size: 0.85em; font-family: var(--font-mono); }

.manual-details {
  margin-top: var(--space-lg);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: var(--space-sm);
}
.manual-details summary { cursor: pointer; font-weight: 600; padding: var(--space-xs); }

.loading-inline { display: flex; align-items: center; gap: var(--space-sm); color: var(--text-secondary); }
.spinner.sm { width: 14px; height: 14px; border-width: 2px; }
</style>
