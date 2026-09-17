import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { initAuth } from './lib/auth.js'
import { followSignInAcrossTabs } from './lib/api.js'
import { initTheme } from './lib/theme.js'
import './style.css'

// Restore auth from localStorage on load, and keep this tab on the same sign-in
// as every other tab afterwards.
initAuth()
followSignInAcrossTabs()

// Sync the reactive theme store with what the inline boot script in index.html
// already applied, and start tracking the OS preference for `system` mode.
initTheme()

const app = createApp(App)
app.use(router)
app.mount('#app')
