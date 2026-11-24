import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    allowOnly: false,
    passWithNoTests: false,
    include: ['tests/**/*.spec.ts'],
  },
})
