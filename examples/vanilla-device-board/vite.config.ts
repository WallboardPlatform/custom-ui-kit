import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { kitAliases } from '../vite-shared';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), resolve: { alias: kitAliases }, server: { port: 8746, strictPort: true }, build: { outDir: '../../dist/examples/vanilla', emptyOutDir: true } });
