import { fileURLToPath } from 'node:url';
export const kitAliases = [
  ...['browser', 'api', 'vue', 'backend'].map((name) => ({ find: new RegExp(`^@wallboard/custom-ui-kit/${name}$`), replacement: fileURLToPath(new URL(`../src/${name}/index.ts`, import.meta.url)) })),
  { find: /^@wallboard\/custom-ui-kit\/theme\.css$/, replacement: fileURLToPath(new URL('../src/vue/theme.css', import.meta.url)) },
  { find: /^@wallboard\/custom-ui-kit$/, replacement: fileURLToPath(new URL('../src/index.ts', import.meta.url)) },
];
