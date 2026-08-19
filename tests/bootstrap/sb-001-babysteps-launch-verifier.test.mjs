import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBabystepsLaunchVerifier, LaunchVerifierError } from '../../src/container/internal/bootstrap/babysteps-launch-verifier.mjs';
import { validateLaunchContext, LaunchContextError } from '../../src/container/internal/bootstrap/launch-context.mjs';

const CURRENT_KEY = 'k'.repeat(32);
const PREVIOUS_KEY = 'p'.repeat(32);

const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1',
});

function signWith(claims, key) {
  return createHmac('sha256', key).update(JSON.stringify(claims, Object.keys(claims).sort())).digest('hex');
}

function envelopeSignedWith(claims, key) {
  return { claims: structuredClone(claims), proof: signWith(claims, key) };
}

test('SB-001-P0 constructing the verifier without a sufficiently long key fails closed at configuration time', () => {
  assert.throws(() => createBabystepsLaunchVerifier({ verificationKey: 'too-short' }), (e) => e instanceof LaunchVerifierError && e.code === 'LAUNCH_VERIFIER_MISCONFIGURED');
  assert.throws(() => createBabystepsLaunchVerifier({}), (e) => e instanceof LaunchVerifierError && e.code === 'LAUNCH_VERIFIER_MISCONFIGURED');
});

test('SB-001-P0 a validly signed envelope verifies successfully and returns exactly the claims', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY });
  const result = await verify(envelopeSignedWith(baseClaims, CURRENT_KEY));
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, baseClaims);
});

test('SB-001-P0 a tampered claim invalidates the signature', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY });
  const tampered = envelopeSignedWith(baseClaims, CURRENT_KEY);
  tampered.claims.learnerId = 'attacker';
  const result = await verify(tampered);
  assert.equal(result.ok, false);
});

test('SB-001-P0 an envelope signed with an unknown key is unverifiable', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY });
  const result = await verify(envelopeSignedWith(baseClaims, 'x'.repeat(32)));
  assert.equal(result.ok, false);
});

test('SB-001-P0 malformed/missing proof or claims fail closed rather than throwing', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY });
  assert.deepEqual(await verify(null), { ok: false });
  assert.deepEqual(await verify({}), { ok: false });
  assert.deepEqual(await verify({ claims: baseClaims }), { ok: false });
  assert.deepEqual(await verify({ claims: baseClaims, proof: 'not-hex-!!' }), { ok: false });
  assert.deepEqual(await verify({ claims: baseClaims, proof: 'ab' }), { ok: false });
});

test('SB-001-P0 rotated/previous verification keys remain accepted for still-valid envelopes', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY, previousVerificationKeys: [PREVIOUS_KEY] });
  const signedWithPrevious = envelopeSignedWith(baseClaims, PREVIOUS_KEY);
  const result = await verify(signedWithPrevious);
  assert.equal(result.ok, true);
});

test('SB-001-P0 the verifier never exposes the verification key or raw proof material', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY });
  const result = await verify(envelopeSignedWith(baseClaims, CURRENT_KEY));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(CURRENT_KEY), false);
});

test('SB-001-P0 integrates end to end with validateLaunchContext using only the approved Babysteps contract', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY });
  const runtime = await validateLaunchContext({
    launchContext: envelopeSignedWith(baseClaims, CURRENT_KEY),
    manifest: { appId: 'magical-math' },
    expectedReleaseId: 'release-1',
    expectedSessionId: 'session-1',
    verifier: verify,
    now: () => new Date('2026-08-18T00:10:00.000Z'),
  });
  assert.equal(runtime.learnerId, 'learner-1');
});

test('SB-001-P0 a tampered envelope is rejected by validateLaunchContext through the production verifier without exposing the proof', async () => {
  const verify = createBabystepsLaunchVerifier({ verificationKey: CURRENT_KEY });
  const tampered = envelopeSignedWith(baseClaims, CURRENT_KEY);
  tampered.claims.sessionId = 'session-evil';
  await assert.rejects(
    () => validateLaunchContext({
      launchContext: tampered,
      manifest: { appId: 'magical-math' },
      expectedReleaseId: 'release-1',
      expectedSessionId: 'session-1',
      verifier: verify,
      now: () => new Date('2026-08-18T00:10:00.000Z'),
    }),
    (e) => e instanceof LaunchContextError && e.code === 'LAUNCH_CONTEXT_INVALID' && !JSON.stringify(e).includes(tampered.proof)
  );
});
