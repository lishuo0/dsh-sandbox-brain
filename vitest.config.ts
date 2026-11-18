import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  server: {
    fs: {
      allow: [resolve(root, '..')],
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: { reporter: ['text', 'html'] },
  },
})
