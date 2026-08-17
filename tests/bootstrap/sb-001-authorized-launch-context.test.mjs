import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext, bootstrapAuthorizedLaunch, LaunchContextError } from '../../src/container/internal/bootstrap/launch-context.mjs';

const manifest = Object.freeze({ appId: 'magical-math' });
const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims = baseClaims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
const opts = { manifest, expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier, now: () => new Date('2026-08-18T00:10:00.000Z') };

test('SB-001-AC01 valid authorized context establishes runtime before app executes', async () => {
  let executed = false;
  const result = await bootstrapAuthorizedLaunch({ launchContext: envelope(), ...opts, loadApp: async (runtime) => { executed = true; assert.equal(runtime.appId, 'magical-math'); return 'loaded'; } });
  assert.equal(executed, true); assert.equal(result.app, 'loaded'); assert.equal(Object.isFrozen(result.runtimeContext), true);
});

test('SB-001-AC02 missing context fails closed', async () => {
  let executed = false;
  await assert.rejects(() => bootstrapAuthorizedLaunch({ ...opts, loadApp: async () => { executed = true; } }), e => e.code === 'LAUNCH_CONTEXT_MISSING');
  assert.equal(executed, false);
});

test('SB-001-AC03 expired context is rejected', async () => {
  const claims = { ...baseClaims, expiresAt: '2026-08-18T00:05:00.000Z' };
  await assert.rejects(() => validateLaunchContext({ launchContext: envelope(claims), ...opts }), e => e.code === 'LAUNCH_CONTEXT_EXPIRED');
});

test('SB-001-AC04 malformed/tampered context rejects without privileged exposure', async () => {
  const bad = envelope(); bad.claims.learnerId = 'attacker';
  await assert.rejects(() => validateLaunchContext({ launchContext: bad, ...opts }), e => e instanceof LaunchContextError && e.code === 'LAUNCH_CONTEXT_INVALID' && !JSON.stringify(e).includes(bad.proof));
});

test('SB-001-AC05 app identity mismatch is rejected', async () => {
  await assert.rejects(() => validateLaunchContext({ launchContext: envelope(), ...opts, manifest: { appId: 'chess-master' } }), e => e.code === 'LAUNCH_CONTEXT_MISMATCH');
});

test('SB-001-AC06 substituted release is rejected', async () => {
  await assert.rejects(() => validateLaunchContext({ launchContext: envelope(), ...opts, expectedReleaseId: 'release-2' }), e => e.code === 'LAUNCH_CONTEXT_MISMATCH');
});

test('SB-001-AC07 modified learner/session identifiers do not become authorized', async () => {
  const bad = envelope(); bad.claims.sessionId = 'session-evil';
  await assert.rejects(() => validateLaunchContext({ launchContext: bad, ...opts }), e => e.code === 'LAUNCH_CONTEXT_INVALID');
});

test('SB-001-AC08 app execution waits for validation completion', async () => {
  let release; const gate = new Promise(r => { release = r; }); let executed = false;
  const pending = bootstrapAuthorizedLaunch({ launchContext: envelope(), ...opts, verifier: async (ctx) => { await gate; return verifier(ctx); }, loadApp: async () => { executed = true; } });
  await Promise.resolve(); assert.equal(executed, false); release(); await pending; assert.equal(executed, true);
});

test('SB-001-AC09 validator consumes upstream authorization and implements no business decisions', async () => {
  const runtime = await validateLaunchContext({ launchContext: envelope(), ...opts });
  assert.deepEqual(Object.keys(runtime).sort(), ['appId','correlationId','issuedAt','launchMode','learnerId','releaseId','sessionId'].sort());
});

test('SB-001-AC10 runtime payload is minimal and excludes parent/billing/subscription data', async () => {
  const runtime = await validateLaunchContext({ launchContext: envelope(), ...opts });
  const serialized = JSON.stringify(runtime);
  for (const forbidden of ['parent','payment','billing','subscription','token','proof']) assert.equal(serialized.toLowerCase().includes(forbidden), false);
});
