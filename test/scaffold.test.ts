import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('refuses to replace an existing application directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallboard-scaffold-existing-'));
  const existing = join(directory, 'customer-source.txt');
  try {
    await writeFile(existing, 'existing application source');
    expect(() => execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/new-app.mjs', import.meta.url)), 'vue', directory], { stdio: 'pipe' })).toThrow();
    expect(await readFile(existing, 'utf8')).toBe('existing application source');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
