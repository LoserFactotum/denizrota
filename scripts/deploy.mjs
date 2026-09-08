// Siteyi toplayip gh-pages dalina yayinlar: node scripts/deploy.mjs
// Yayin duzeni: web/ icerigi kokte, engine/ altinda — gelistirme sunucusuyla ayni.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, '_site');
const run = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
const capture = (...args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();

console.log('Testler calisiyor…');
execFileSync(process.execPath, [join(ROOT, 'test', 'run.mjs')], { cwd: ROOT, stdio: 'inherit' });

await rm(SITE, { recursive: true, force: true });
await mkdir(SITE, { recursive: true });
await cp(join(ROOT, 'web'), SITE, { recursive: true });
await cp(join(ROOT, 'engine'), join(SITE, 'engine'), { recursive: true });
await writeFile(join(SITE, '.nojekyll'), '');

const commit = capture('rev-parse', '--short', 'HEAD');
run('add', '-f', '_site');
const tree = capture('write-tree', '--prefix=_site/');
let parent = '';
try { parent = capture('rev-parse', 'refs/heads/gh-pages'); } catch { /* ilk yayin */ }
const args = ['commit-tree', tree, '-m', `Yayin: ${commit}`];
if (parent) args.splice(2, 0, '-p', parent);
const created = execFileSync('git', args, { cwd: ROOT }).toString().trim();
run('update-ref', 'refs/heads/gh-pages', created);
run('reset', '-q', 'HEAD', '--', '_site');
await rm(SITE, { recursive: true, force: true });
run('push', '-f', 'origin', 'gh-pages');
console.log('\nYayinlandi: https://loserfactotum.github.io/denizrota/');
