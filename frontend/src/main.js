import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { initAuth } from './lib/auth.js'
import { initTheme } from './lib/theme.js'
import './style.css'

// Restore auth from sessionStorage on load
initAuth()

// Sync the reactive theme store with what the inline boot script in index.html
// already applied, and start tracking the OS preference for `system` mode.
initTheme()

const app = createApp(App)
app.use(router)
app.mount('#app')
