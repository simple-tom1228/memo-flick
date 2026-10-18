import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [react(), cloudflare(process.env.E2E_LOCAL === '1' ? { configPath: './wrangler.e2e.jsonc' } : {})],
})
