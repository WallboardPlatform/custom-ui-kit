import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { kitAliases } from '../vite-shared';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [vue()], resolve: { alias: kitAliases }, server: { port: 8745, strictPort: true }, build: { outDir: '../../dist/examples/vue', emptyOutDir: true } });
