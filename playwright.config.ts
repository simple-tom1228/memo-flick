import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const temp = join(tmpdir(), 'memo-flick-e2e')
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 8000 },
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'iPhone 14', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: { command: 'npx wrangler d1 migrations apply memo-flick-db --local --config wrangler.e2e.jsonc && npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', timeout: 120000, reuseExistingServer: false, env: { E2E_LOCAL: '1', XDG_CONFIG_HOME: temp, MINIFLARE_REGISTRY_PATH: join(temp, 'registry'), WRANGLER_LOG_PATH: join(temp, 'wrangler.log') } },
})
