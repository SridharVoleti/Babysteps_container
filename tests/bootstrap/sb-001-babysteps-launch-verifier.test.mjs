import test from 'node:test';
import assert from 'node:assert/strict';
import { createBabystepsLaunchVerifier, LaunchVerifierError } from '../../src/container/internal/bootstrap/babysteps-launch-verifier.mjs';
import { validateLaunchContext, LaunchContextError } from '../../src/container/internal/bootstrap/launch-context.mjs';

const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1',
});

const ALGORITHM = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGN_PARAMS = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });

function canonicalize(claims) {
  return JSON.stringify(claims, Object.keys(claims).sort());
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Simulates the Babysteps signing side, which this test module has NO analog to inside
// src/ - only a test harness ever holds a private key.
async function generateBabystepsKeyPair() {
  const keyPair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  delete publicJwk.d;
  return { privateKey: keyPair.privateKey, publicJwk };
}

async function signWith(claims, privateKey) {
  const data = new TextEncoder().encode(canonicalize(claims));
  const signature = await crypto.subtle.sign(SIGN_PARAMS, privateKey, data);
  return bytesToHex(signature);
}

async function envelopeSignedWith(claims, privateKey, kid) {
  return { claims: structuredClone(claims), proof: await signWith(claims, privateKey), kid };
}

test('SB-001-P0 constructing the verifier without any public key fails closed at configuration time', () => {
  assert.throws(() => createBabystepsLaunchVerifier({}), (e) => e instanceof LaunchVerifierError && e.code === 'LAUNCH_VERIFIER_MISCONFIGURED');
  assert.throws(() => createBabystepsLaunchVerifier({ publicKeys: {} }), (e) => e instanceof LaunchVerifierError && e.code === 'LAUNCH_VERIFIER_MISCONFIGURED');
  assert.throws(() => createBabystepsLaunchVerifier({ publicKeys: { k1: { kty: 'EC', crv: 'P-256' } } }), (e) => e.code === 'LAUNCH_VERIFIER_MISCONFIGURED');
});

test('SB-001-P0 a validly signed envelope verifies successfully and returns exactly the claims', async () => {
  const { privateKey, publicJwk } = await generateBabystepsKeyPair();
  const verify = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': publicJwk } });
  const result = await verify(await envelopeSignedWith(baseClaims, privateKey, 'key-2026-08'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, baseClaims);
});

test('SB-001-P0 a tampered claim invalidates the signature', async () => {
  const { privateKey, publicJwk } = await generateBabystepsKeyPair();
  const verify = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': publicJwk } });
  const tampered = await envelopeSignedWith(baseClaims, privateKey, 'key-2026-08');
  tampered.claims.learnerId = 'attacker';
  const result = await verify(tampered);
  assert.equal(result.ok, false);
});

test('SB-001-P0 an envelope signed by a key that is not Babysteps-held (wrong kid or attacker key) is unverifiable', async () => {
  const { publicJwk } = await generateBabystepsKeyPair();
  const verify = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': publicJwk } });

  // Unknown kid.
  const { privateKey: attackerKey } = await generateBabystepsKeyPair();
  const unknownKid = await envelopeSignedWith(baseClaims, attackerKey, 'unregistered-kid');
  assert.equal((await verify(unknownKid)).ok, false);

  // Attacker signs with their own private key but claims the real kid - rejected because
  // verification uses the REGISTERED public key for that kid, not the attacker's key.
  const forgedButKnownKid = await envelopeSignedWith(baseClaims, attackerKey, 'key-2026-08');
  assert.equal((await verify(forgedButKnownKid)).ok, false);
});

test('SB-001-P0 malformed/missing proof, claims or kid fail closed rather than throwing', async () => {
  const { privateKey, publicJwk } = await generateBabystepsKeyPair();
  const verify = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': publicJwk } });
  assert.deepEqual(await verify(null), { ok: false });
  assert.deepEqual(await verify({}), { ok: false });
  assert.deepEqual(await verify({ claims: baseClaims }), { ok: false });
  assert.deepEqual(await verify({ claims: baseClaims, proof: 'not-hex-!!', kid: 'key-2026-08' }), { ok: false });
  assert.deepEqual(await verify({ claims: baseClaims, proof: 'ab', kid: 'key-2026-08' }), { ok: false });
  const validProof = await signWith(baseClaims, privateKey);
  assert.deepEqual(await verify({ claims: baseClaims, proof: validProof }), { ok: false });
  assert.deepEqual(await verify({ claims: baseClaims, proof: validProof, kid: 'not a valid kid!!' }), { ok: false });
});

test('SB-001-P0 rotated verification keys remain accepted for still-valid envelopes, and a revoked key stops verifying', async () => {
  const current = await generateBabystepsKeyPair();
  const previous = await generateBabystepsKeyPair();

  const verifyDuringRotation = createBabystepsLaunchVerifier({
    publicKeys: { 'key-2026-08': current.publicJwk, 'key-2026-05': previous.publicJwk },
  });
  const signedWithPrevious = await envelopeSignedWith(baseClaims, previous.privateKey, 'key-2026-05');
  assert.equal((await verifyDuringRotation(signedWithPrevious)).ok, true);
  const signedWithCurrent = await envelopeSignedWith(baseClaims, current.privateKey, 'key-2026-08');
  assert.equal((await verifyDuringRotation(signedWithCurrent)).ok, true);

  // Once the old key is fully revoked (removed from configuration), envelopes signed with
  // it can no longer verify, even though the signature itself is still mathematically valid.
  const verifyAfterRevocation = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': current.publicJwk } });
  assert.equal((await verifyAfterRevocation(signedWithPrevious)).ok, false);
});

test('SB-001-P0 the verifier holds no signing capability - it is configured with public key material only', async () => {
  const { publicJwk } = await generateBabystepsKeyPair();
  assert.equal('d' in publicJwk, false);
  const verify = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': publicJwk } });
  const result = await verify({ claims: baseClaims, proof: 'ab'.repeat(32), kid: 'key-2026-08' });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(JSON.stringify(publicJwk.x)), false);
});

test('SB-001-P0 integrates end to end with validateLaunchContext using only the approved Babysteps contract', async () => {
  const { privateKey, publicJwk } = await generateBabystepsKeyPair();
  const verify = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': publicJwk } });
  const runtime = await validateLaunchContext({
    launchContext: await envelopeSignedWith(baseClaims, privateKey, 'key-2026-08'),
    manifest: { appId: 'magical-math' },
    expectedReleaseId: 'release-1',
    expectedSessionId: 'session-1',
    verifier: verify,
    now: () => new Date('2026-08-18T00:10:00.000Z'),
  });
  assert.equal(runtime.learnerId, 'learner-1');
});

test('SB-001-P0 a tampered envelope is rejected by validateLaunchContext through the production verifier without exposing the proof', async () => {
  const { privateKey, publicJwk } = await generateBabystepsKeyPair();
  const verify = createBabystepsLaunchVerifier({ publicKeys: { 'key-2026-08': publicJwk } });
  const tampered = await envelopeSignedWith(baseClaims, privateKey, 'key-2026-08');
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
