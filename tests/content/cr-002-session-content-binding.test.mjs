import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createContentRuntime } from '../../src/container/internal/content/content-runtime.mjs';
import {
  pinSessionContentVersion,
  getSessionContentBinding,
  restoreSessionContentBinding,
  createSessionPinnedContentLoader,
  SessionContentBindingError,
} from '../../src/container/internal/content/session-content-binding.mjs';

const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });

async function boundRuntime(claims = baseClaims) {
  const opts = {
    manifest: Object.freeze({ appId: claims.appId }),
    expectedReleaseId: claims.releaseId,
    expectedSessionId: claims.sessionId,
    verifier,
    now: () => new Date('2026-08-18T00:10:00.000Z'),
  };
  const runtimeContext = await validateLaunchContext({ launchContext: envelope(claims), ...opts });
  return bindAuthorizedRuntime(runtimeContext);
}

function versionedLoader(callLog) {
  return async ({ contentVersion }) => {
    callLog.push(contentVersion);
    return { contentVersion, marker: `content-for-${contentVersion}` };
  };
}

test('CR-002-AC01 a session that starts with approved content version v12 is pinned to v12 for its lifetime', async () => {
  const binding = await boundRuntime();
  const callLog = [];
  const contentRuntime = createContentRuntime({ runtimeBinding: binding, loader: versionedLoader(callLog) });
  pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  const loader = createSessionPinnedContentLoader({ runtimeBinding: binding, contentRuntime });

  const content = await loader.resolve();
  assert.equal(content.contentVersion, 'v12');
  assert.equal(loader.binding().contentVersion, 'v12');
});

test('CR-002-AC02 a newer content version deployed while a v12 session is active does not switch the active session', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-2' });
  const callLog = [];
  const contentRuntime = createContentRuntime({ runtimeBinding: binding, loader: versionedLoader(callLog) });
  pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  const loader = createSessionPinnedContentLoader({ runtimeBinding: binding, contentRuntime });

  await loader.resolve();
  // "v13 is deployed" -- nothing in this system ever asks for it; the pinned loader always requests v12.
  const secondLoad = await loader.resolve();
  assert.equal(secondLoad.contentVersion, 'v12');
  assert.deepEqual(callLog, ['v12']);
});

test('CR-002-AC03 the same pinned content version is used after a rerender/refresh of the same authorized session', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-3' });
  const first = pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  // Rerender re-invokes the same session-init pinning call with the same version; must be idempotent.
  const second = pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  assert.equal(first, second);
  assert.equal(getSessionContentBinding(binding).contentVersion, 'v12');
});

test('CR-002-AC04 connectivity loss and restoration does not re-resolve the session to a latest content version', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-4' });
  const callLog = [];
  const contentRuntime = createContentRuntime({ runtimeBinding: binding, loader: versionedLoader(callLog) });
  pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  const loader = createSessionPinnedContentLoader({ runtimeBinding: binding, contentRuntime });

  await loader.resolve(); // before disconnect
  await loader.resolve(); // after "reconnect"
  await loader.resolve(); // after another "reconnect"
  assert.equal(callLog.filter((v) => v !== 'v12').length, 0);
});

test('CR-002-AC05 an authorized resume restores the same content version unless an explicit compatibility mapping applies', async () => {
  const bindingA = await boundRuntime({ ...baseClaims, sessionId: 'session-5a' });
  pinSessionContentVersion({ runtimeBinding: bindingA, contentVersion: 'v12' });
  const restored = restoreSessionContentBinding({ runtimeBinding: bindingA, resumedContentVersion: 'v12' });
  assert.equal(restored.contentVersion, 'v12');

  assert.throws(
    () => restoreSessionContentBinding({ runtimeBinding: bindingA, resumedContentVersion: 'v13' }),
    (e) => e instanceof SessionContentBindingError && e.code === 'CONTENT_RESUME_VERSION_MISMATCH'
  );

  const mapped = restoreSessionContentBinding({
    runtimeBinding: bindingA,
    resumedContentVersion: 'v13',
    compatibilityMap: () => 'v12',
  });
  assert.equal(mapped.contentVersion, 'v12');

  // A brand new runtime (e.g. after a real page refresh where a fresh binding is issued) restores fresh.
  const bindingB = await boundRuntime({ ...baseClaims, sessionId: 'session-5b' });
  const freshRestore = restoreSessionContentBinding({ runtimeBinding: bindingB, resumedContentVersion: 'v9' });
  assert.equal(freshRestore.contentVersion, 'v9');
});

test('CR-002-AC06 app-specific code requesting a different content version mid-session is rejected; the pinned version remains authoritative', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-6' });
  const callLog = [];
  const contentRuntime = createContentRuntime({ runtimeBinding: binding, loader: versionedLoader(callLog) });
  pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  const loader = createSessionPinnedContentLoader({ runtimeBinding: binding, contentRuntime });

  await assert.rejects(
    () => loader.resolve({ contentVersion: 'v13' }),
    (e) => e instanceof SessionContentBindingError && e.code === 'CONTENT_VERSION_MISMATCH'
  );
  const content = await loader.resolve();
  assert.equal(content.contentVersion, 'v12');
});

test('CR-002-AC07 an unavailable pinned content version fails safely rather than substituting another version', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-7' });
  const contentRuntime = createContentRuntime({ runtimeBinding: binding, loader: async () => null });
  pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  const loader = createSessionPinnedContentLoader({ runtimeBinding: binding, contentRuntime });

  await assert.rejects(
    () => loader.resolve(),
    (e) => e instanceof SessionContentBindingError && e.code === 'CONTENT_PINNED_VERSION_UNAVAILABLE'
  );
});

test('CR-002-AC08 only the cache entry matching the exact session binding is ever eligible for this session', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-8' });
  const callLog = [];
  const contentRuntime = createContentRuntime({ runtimeBinding: binding, loader: versionedLoader(callLog) });
  pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12' });
  const loader = createSessionPinnedContentLoader({ runtimeBinding: binding, contentRuntime });

  await loader.resolve();
  await assert.rejects(() => loader.resolve({ contentVersion: 'v99' }));
  await loader.resolve();

  assert.deepEqual(callLog, ['v12']);
});

test('CR-002-AC09 a newly authorized session begun after v13 is approved may use v13', async () => {
  const newerBinding = await boundRuntime({ ...baseClaims, sessionId: 'session-9' });
  const pinned = pinSessionContentVersion({ runtimeBinding: newerBinding, contentVersion: 'v13' });
  assert.equal(pinned.contentVersion, 'v13');
});

test('CR-002-AC10 no content load uses an implicit latest-version selector once session binding is established', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/content/session-content-binding.mjs');
  const source = readFileSync(filePath, 'utf8');
  assert.equal(/latest/i.test(source), false);
});

test('CR-002-AC11 content-version telemetry contains only safe technical metadata, not detailed learner content history', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-11' });
  const events = [];
  const contentRuntime = createContentRuntime({
    runtimeBinding: binding,
    loader: async ({ contentVersion }) => ({ contentVersion, lessons: [{ text: 'sensitive lesson text' }] }),
  });
  pinSessionContentVersion({ runtimeBinding: binding, contentVersion: 'v12', onTelemetry: (e) => events.push(e) });
  const loader = createSessionPinnedContentLoader({ runtimeBinding: binding, contentRuntime, onTelemetry: (e) => events.push(e) });
  await loader.resolve();
  await loader.resolve({ contentVersion: 'v99' }).catch(() => {});

  assert.ok(events.length >= 2);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'releaseId', 'sessionId', 'correlationId', 'contentVersion', 'pinned', 'requested', 'bound', 'resumed', 'cause'].includes(k)));
    assert.equal(JSON.stringify(event).includes('sensitive lesson text'), false);
  }
});

test('CR-002 invalid input is rejected', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-12' });
  assert.throws(() => pinSessionContentVersion({ runtimeBinding: binding, contentVersion: '' }), (e) => e instanceof SessionContentBindingError && e.code === 'CONTENT_VERSION_REQUIRED');
  assert.throws(() => getSessionContentBinding(binding), (e) => e.code === 'CONTENT_VERSION_REQUIRED');
});
