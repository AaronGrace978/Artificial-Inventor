import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function scan(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) files.push(...await scan(path));
    else if (/\.(?:js|mjs|cjs)$/.test(item.name)) files.push(path);
  }
  return files;
}
for (const file of await scan('src')) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('JavaScript syntax checks passed.');
