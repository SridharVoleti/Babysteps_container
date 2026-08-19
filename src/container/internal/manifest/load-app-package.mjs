import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveManifest } from './index.mjs';
import { getRuntimeContext, RuntimeBindingError } from '../runtime/authorized-runtime-identity.mjs';

// runtimeBinding must be the opaque binding returned by bindAuthorizedRuntime() (SB-002),
// which itself can only be produced from a successfully validated SB-001 launch context.
// This ties app-module import structurally to a prior successful authorization: without a
// valid bound runtime whose appId matches the manifest, no app code is imported (SB-001/CC-002).
export async function loadAppPackage(manifestPath, options = {}, dependencies = {}) {
  const readText = dependencies.readText ?? ((path) => readFile(path, 'utf8'));
  const loadModule = dependencies.loadModule ?? ((url) => import(url));
  const { runtimeBinding } = dependencies;

  let boundIdentity;
  try {
    boundIdentity = getRuntimeContext(runtimeBinding);
  } catch (error) {
    const category = error instanceof RuntimeBindingError ? error.code : 'RUNTIME_CONTEXT_INVALID';
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'AUTHORIZATION_REQUIRED', message: 'App package loading requires an already-authorized runtime binding.', details: { category } })
    });
  }

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

  if (boundIdentity.appId !== resolvedManifest.manifest.appId) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'APP_IDENTITY_MISMATCH', message: 'The authorized runtime appId does not match the validated app manifest appId.' })
    });
  }

  const entryPath = resolve(dirname(manifestPath), resolvedManifest.manifest.entryPoint);
  let module;
  try {
    module = await loadModule(pathToFileURL(entryPath).href);
  } catch {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'ENTRY_POINT_INVALID', message: 'Validated app entry point could not be loaded.' })
    });
  }

  const appDefinition = module?.default;
  if (!appDefinition || typeof appDefinition.id !== 'string' || appDefinition.id !== resolvedManifest.manifest.appId) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: 'APP_IDENTITY_MISMATCH',
        message: 'The loaded application identity does not match the validated app manifest appId.',
      })
    });
  }

  return Object.freeze({
    ok: true,
    manifest: resolvedManifest.manifest,
    degradedOptionalCapabilities: resolvedManifest.degradedOptionalCapabilities,
    module,
    appDefinition,
  });
}
