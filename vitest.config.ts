import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // See test/setup.ts: requests go to the test's own server, not to
    // whichever program on the machine shares its port number.
    setupFiles: ['test/setup.ts'],
    // These are integration tests against a real Postgres, several requests
    // each, some hashing passwords with bcrypt on purpose. Five seconds was
    // enough alone and not under a full parallel run, where a test would time
    // out while doing nothing wrong.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
