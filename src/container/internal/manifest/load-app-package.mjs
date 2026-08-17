import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveManifest } from './index.mjs';

export async function loadAppPackage(manifestPath, options = {}, dependencies = {}) {
  const readText = dependencies.readText ?? ((path) => readFile(path, 'utf8'));
  const loadModule = dependencies.loadModule ?? ((url) => import(url));

  let parsed;
  try {
    parsed = JSON.parse(await readText(manifestPath));
  } catch {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'MANIFEST_INVALID', message: 'App manifest cannot be read or parsed.' })
    });
  }

  const resolvedManifest = resolveManifest(parsed, options);
  if (!resolvedManifest.ok) return resolvedManifest;

  const entryPath = resolve(dirname(manifestPath), resolvedManifest.manifest.entryPoint);
  try {
    const module = await loadModule(pathToFileURL(entryPath).href);
    return Object.freeze({ ok: true, manifest: resolvedManifest.manifest, degradedOptionalCapabilities: resolvedManifest.degradedOptionalCapabilities, module });
  } catch {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'ENTRY_POINT_INVALID', message: 'Validated app entry point could not be loaded.' })
    });
  }
}
