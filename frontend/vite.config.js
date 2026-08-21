import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'serve-schemas',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/schemas/')) {
            const schemaFile = req.url.replace(/^\/schemas\//, '').split('?')[0]
            const schemaPath = resolve(__dirname, '../schemas', schemaFile)
            if (existsSync(schemaPath)) {
              res.setHeader('Content-Type', 'application/json')
              res.end(readFileSync(schemaPath, 'utf8'))
              return
            }
          }
          next()
        })
      },
    },
  ],
  // For GitHub Pages deployment - set base to repo name
  base: process.env.VITE_BASE_URL || '/',
})
