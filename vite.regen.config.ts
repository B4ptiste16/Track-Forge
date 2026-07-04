import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'regen-fbx.ts', formats: ['cjs'], fileName: () => 'regen-fbx.cjs' },
    outDir: 'test-dist',
    emptyOutDir: false,
    minify: false,
    rollupOptions: { external: ['node:fs'] },
  },
});
