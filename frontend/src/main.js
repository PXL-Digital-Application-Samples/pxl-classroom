import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { initAuth } from './lib/auth.js'
import './style.css'

// Restore auth from sessionStorage on load
initAuth()

const app = createApp(App)
app.use(router)
app.mount('#app')
