import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const template = args[0];
const output = args[1];
if (!['vue', 'vanilla'].includes(template) || !output || args.length !== 2) {
  console.error('Usage: npm run new-app -- <vue|vanilla> <new-directory>'); process.exit(1);
}
const destination = resolve(output);
try { await stat(destination); throw new Error('The output directory already exists. Choose a new directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await stat(join(kitRoot, 'dist/index.js')).catch(() => { throw new Error('Build the kit first with npm run build.'); });
await mkdir(destination, { recursive: true });
await cp(join(kitRoot, `examples/${template}-device-board`), destination, { recursive: true });
const vendor = join(destination, 'vendor/wallboard-custom-ui-kit');
await mkdir(vendor, { recursive: true });
for (const name of ['dist', 'src', 'LICENSE']) await cp(join(kitRoot, name), join(vendor, name), { recursive: true, filter: (source) => !source.includes('dist/examples') && !source.includes('dist\\examples') });
const original = JSON.parse(await readFile(join(kitRoot, 'package.json'), 'utf8'));
await writeFile(join(vendor, 'package.json'), JSON.stringify({ name: original.name, version: original.version, type: 'module', license: original.license, exports: original.exports, peerDependencies: original.peerDependencies, peerDependenciesMeta: original.peerDependenciesMeta }, null, 2) + '\n');
const configuration = `import { defineConfig } from 'vite';\n${template === 'vue' ? "import vue from '@vitejs/plugin-vue';\n" : ''}export default defineConfig({ ${template === 'vue' ? 'plugins: [vue()], ' : ''}server: { port: 8745, strictPort: true } });\n`;
await writeFile(join(destination, 'vite.config.ts'), configuration);
await writeFile(join(destination, 'package.json'), JSON.stringify({ name: 'my-wallboard-ui', version: '0.1.0', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', typecheck: template === 'vue' ? 'vue-tsc --noEmit' : 'tsc --noEmit' }, dependencies: { '@wallboard/custom-ui-kit': 'file:./vendor/wallboard-custom-ui-kit', ...(template === 'vue' ? { vue: original.devDependencies.vue } : {}) }, devDependencies: { vite: original.devDependencies.vite, typescript: original.devDependencies.typescript, ...(template === 'vue' ? { '@vitejs/plugin-vue': original.devDependencies['@vitejs/plugin-vue'], 'vue-tsc': original.devDependencies['vue-tsc'] } : {}) } }, null, 2) + '\n');
await writeFile(join(destination, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], types: ['vite/client'], strict: true, skipLibCheck: true, noEmit: true }, include: ['*.ts', '*.vue'] }, null, 2) + '\n');
await writeFile(join(destination, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.local\n');
await writeFile(join(destination, '.env.example'), 'VITE_WB_SERVER_URL=https://your-wallboard.example\n# VITE_WB_CLIENT_ID=your-registered-public-client-id\n');
await writeFile(join(destination, 'README.md'), '# Your Wallboard UI\n\nRun `npm install`, then `npm run dev`. Configure your Wallboard server in `.env.local`, or enter its URL on the connection screen. Run `npm run typecheck` and `npm run build` before deployment.\n\nThe vendored kit is pinned to version ' + original.version + '. Its source and licence are in `vendor/wallboard-custom-ui-kit`. Update intentionally from the canonical public repository. See https://github.com/WallboardPlatform/custom-ui-kit/tree/main/docs for authentication and hosting requirements.\n');
console.log(`Created ${destination}\nInstall dependencies there, then run npm run dev.`);
