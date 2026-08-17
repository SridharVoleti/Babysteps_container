import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveManifest } from '../src/container/internal/manifest/index.mjs';
import { manifestContract } from '../src/container/internal/manifest/contract.mjs';

const appsRoot = process.argv[2] ?? 'apps';
const entries = await readdir(appsRoot, { withFileTypes: true });
let failed = false;

for (const entry of entries.filter((item) => item.isDirectory())) {
  const path = join(appsRoot, entry.name, 'app.manifest.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    console.error(`[MANIFEST_INVALID] ${entry.name}: app.manifest.json is missing or invalid JSON.`);
    failed = true;
    continue;
  }

  const result = resolveManifest(parsed, manifestContract);
  if (!result.ok) {
    console.error(`[${result.error.code}] ${entry.name}: ${result.error.message}`);
    failed = true;
    continue;
  }

  console.log(`[OK] ${entry.name} ${result.manifest.appVersion} contract ${result.manifest.containerContractVersion}`);
}

if (failed) process.exitCode = 1;
