import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'test-realism.ts', formats: ['cjs'], fileName: () => 'test-realism.cjs' },
    outDir: 'test-dist',
    emptyOutDir: true,
    minify: false,
  },
});
