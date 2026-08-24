import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// DR-001: `src/container/**` is the entire client runtime boundary that ends up bundled
// into a final browser learning app (as this project's own layout already separates it
// from Node-only build/conformance tooling under scripts/ and Node-only tests under
// tests/). This walks every file in that boundary and reports any Node-only (`node:*`)
// import, independent of whether a composition root in this repo currently happens to
// import a given module - a capability module the container ships is part of the browser
// runtime graph whether or not anything in this repo wires it up yet.
const IMPORT_SPECIFIER_PATTERN = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const NODE_ONLY_PATTERN = /^node:/;
const RUNTIME_ROOT = path.resolve('src/container');
const EXTENSIONS = new Set(['.mjs', '.js']);

// These two modules use node:fs/node:path/node:url ONLY to build the documented, caller-
// overridable Node-tooling default for reading a manifest/loading an app module
// (dependencies.readText/loadModule in load-app-package.mjs, readManifestText in
// atomic-bootstrap.mjs) - the same dependency-injection seam AM-001/AM-003/API-001 already
// use for environment-specific I/O (playerFactory/recognizerFactory/transport). A real
// browser deployment supplies its own fetch-based readText/loadModule and never exercises
// these Node defaults. Every other module under src/container/** must have zero node:*
// imports with no such override.
const ALLOWED_NODE_DEFAULT_FILES = new Set([
  path.resolve('src/container/internal/manifest/load-app-package.mjs'),
  path.resolve('src/container/internal/bootstrap/atomic-bootstrap.mjs'),
]);

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
    else if (EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

export async function collectBrowserRuntimeGraphViolations(root = RUNTIME_ROOT) {
  const violations = [];
  for await (const filePath of walk(root)) {
    if (ALLOWED_NODE_DEFAULT_FILES.has(path.resolve(filePath))) continue;
    let source;
    try {
      source = await readFile(filePath, 'utf8');
    } catch (error) {
      violations.push({ file: filePath, specifier: null, reason: `UNREADABLE: ${error.message}` });
      continue;
    }
    for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const specifier = match[1];
      if (NODE_ONLY_PATTERN.test(specifier)) {
        violations.push({ file: filePath, specifier });
      }
    }
  }
  return violations;
}

export { RUNTIME_ROOT as BROWSER_RUNTIME_ROOT };
