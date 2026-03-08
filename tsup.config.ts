import { defineConfig } from 'tsup';

export default defineConfig([
  // Server SDK — Node.js target (ESM + CJS for NestJS/CommonJS consumers)
  {
    entry: { server: 'src/server/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
    outDir: 'dist',
    external: ['ws'],
  },
  // React SDK — browser target
  {
    entry: { react: 'src/react/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'es2022',
    outDir: 'dist',
    external: ['react', 'react-dom'],
    // Don't clean again — server build already did it
    clean: false,
  },
  // Shared types (root entry)
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'es2022',
    outDir: 'dist',
    clean: false,
  },
]);