import { defineConfig } from 'vitest/config';

// Vitest runs in Node — the deep modules under test are pure (pixelGrid) or
// filesystem-only (projectStore). No browser environment needed at this stage.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
