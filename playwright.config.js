import { defineConfig } from '@playwright/test'

const port = process.env.VELLUM_TEST_PORT || '5173'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  webServer: {
    command: `bun run dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
})
