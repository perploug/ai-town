import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    // The town simulation runs in real time (walking, engine steps), so give
    // tests room. Individual waits have their own tighter timeouts.
    testTimeout: 90_000,
    hookTimeout: 120_000,
    // The suite shares one live backend + world; run serially to keep
    // assertions about world state deterministic.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
