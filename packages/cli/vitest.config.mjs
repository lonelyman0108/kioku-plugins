import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: 'node_modules/.vite',
  test: {
    testTimeout: 15_000,
  },
})
