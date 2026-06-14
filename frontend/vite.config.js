import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // For GitHub Pages deployment — set base to repo name
  base: process.env.VITE_BASE_URL || '/',
})
