import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { strToU8, zipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const result = await build({
  configFile: false,
  root: fileURLToPath(root),
  resolve: { alias: { '@wallboard/custom-ui-kit': fileURLToPath(new URL('src/index.ts', root)) } },
  build: {
    write: false, sourcemap: false, minify: true,
    lib: { entry: fileURLToPath(new URL('examples/embedded-device-board/main.ts', root)), name: 'WallboardFleetOverview', formats: ['iife'] },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = Array.isArray(result) ? result.flatMap(item => item.output) : result.output;
const script = output.find(item => item.type === 'chunk');
const styles = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
if (!script || output.some(item => item !== script && !styles.includes(item))) throw new Error('The embedded example must contain one script and inline styles only.');
const css = styles.map(item => typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source)).join('\n');
const template = await readFile(new URL('examples/embedded-device-board/index.html', root), 'utf8');
const html = template.replace('/* EMBEDDED_STYLES */', css.replace(/<\/style/gi, '<\\/style'))
  .replace('/* EMBEDDED_SCRIPT */', script.code.replace(/<\/script/gi, '<\\/script'));
const destination = new URL('dist/examples/embedded/', root);
await mkdir(destination, { recursive: true });
await writeFile(new URL('index.html', destination), html);
await writeFile(new URL('fleet-overview.zip', destination), zipSync({ 'index.html': strToU8(html) }));
console.log('Built embedded Fleet Overview: dist/examples/embedded/index.html and fleet-overview.zip');
