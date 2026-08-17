import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { inspectSource } from './architecture-rules.mjs';

const root = process.argv[2] ?? 'apps';
const extensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

async function* walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (extensions.has(path.extname(entry.name))) yield full;
  }
}

const violations = [];
for await (const filePath of walk(root)) {
  const source = await readFile(filePath, 'utf8');
  violations.push(...inspectSource(filePath, source));
}

if (violations.length) {
  console.error('CC-001 architecture boundary violations:');
  for (const violation of violations) {
    console.error(`- [${violation.code}] ${violation.filePath}: ${violation.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('CC-001 architecture boundary checks passed.');
}
