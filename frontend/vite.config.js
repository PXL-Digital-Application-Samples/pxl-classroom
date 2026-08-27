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
  resolve: {
    alias: {
      // The browser half of the `#deployment` subpath import.
      //
      // Modules under lib/ are isomorphic: the hub runs them in Node and the
      // SPA bundles the same files. They need deployment.yml's values, but the
      // Node reader uses node:fs and node:url, and bundling that put
      // `fileURLToPath` into the browser - where it is not a function, so every
      // route loading lib/archive-repo.mjs or lib/audit.mjs rendered a blank
      // page. Node resolves `#deployment` through the root package.json
      // "imports" field; this alias is what resolves it here.
      //
      // Both readers parse the SAME deployment.yml and export the same names,
      // so this is one source of truth with two loaders - not a fork.
      '#deployment': resolve(__dirname, 'src/lib/deployment.js'),
    },
  },

  // For GitHub Pages deployment - set base to repo name
  base: process.env.VITE_BASE_URL || '/',
})
