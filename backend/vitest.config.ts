import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/tests/setup.ts'],

    /**
     * Run test FILES one at a time.
     *
     * Every suite here is an integration test against one shared Postgres, and
     * isolation between files rests on hand-picked UUID ranges — a convention, not
     * a guarantee. Running them in parallel also multiplies connection pressure;
     * that produced an intermittent "Connection terminated unexpectedly" and a run
     * where 7 of 11 files failed and the next run passed cleanly.
     *
     * The whole suite takes a few seconds, so serialising costs nothing and removes
     * an entire class of flakiness. Tests within a file still run in order.
     */
    fileParallelism: false,
  },
})
