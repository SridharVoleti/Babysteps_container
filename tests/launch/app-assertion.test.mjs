import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeJwt } from 'jose'
import { appLaunchConfig } from '../../lib/platform/app-launch/config.mjs'
import { mintAppAssertion, APP_ASSERTION_AUDIENCE } from '../../lib/platform/app-launch/app-assertion.mjs'
import { makeEnv, verifyAppAssertion, CLIENT_ID } from './_helpers.mjs'

test('mints an EdDSA assertion BabySteps can verify with the public key', async () => {
  const { env, signingPublicJwk } = makeEnv()
  const cfg = appLaunchConfig(env)

  const token = await mintAppAssertion(cfg)
  const { payload, protectedHeader } = await verifyAppAssertion(token, signingPublicJwk)

  assert.equal(protectedHeader.alg, 'EdDSA')
  assert.equal(payload.iss, CLIENT_ID)
  assert.equal(payload.sub, CLIENT_ID)
  assert.equal(payload.aud, APP_ASSERTION_AUDIENCE)
  assert.equal(payload.app_id, 'chessmaster')
  assert.equal(payload.environment, 'test')
  assert.equal(payload.deployment_id, 'deploy-1')
})

test('assertion is valid for exactly 60 seconds', async () => {
  const { env } = makeEnv()
  const cfg = appLaunchConfig(env)
  const now = new Date('2026-08-27T10:00:00.000Z')

  const token = await mintAppAssertion(cfg, { now: () => now })
  const payload = decodeJwt(token)

  assert.equal(payload.iat, Math.floor(now.getTime() / 1000))
  assert.equal(payload.exp - payload.iat, 60)
})

test('each call uses a fresh jti', async () => {
  const { env } = makeEnv()
  const cfg = appLaunchConfig(env)
  const a = decodeJwt(await mintAppAssertion(cfg))
  const b = decodeJwt(await mintAppAssertion(cfg))
  assert.ok(a.jti && b.jti)
  assert.notEqual(a.jti, b.jti)
})

test('an assertion signed by our key does NOT verify against a different public key', async () => {
  const { env } = makeEnv()
  const cfg = appLaunchConfig(env)
  const token = await mintAppAssertion(cfg)
  const other = makeEnv()
  await assert.rejects(() => verifyAppAssertion(token, other.signingPublicJwk))
})
