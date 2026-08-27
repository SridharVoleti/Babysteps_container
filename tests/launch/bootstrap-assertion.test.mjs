import test from 'node:test'
import assert from 'node:assert/strict'
import { appLaunchConfig } from '../../lib/platform/app-launch/config.mjs'
import { verifyBootstrapAssertion } from '../../lib/platform/app-launch/bootstrap-assertion.mjs'
import { AppLaunchError } from '../../lib/platform/app-launch/errors.mjs'
import { makeEnv, signBootstrap, LEARNER_CLAIMS } from './_helpers.mjs'

function cfgFor(overrides) {
  return appLaunchConfig(makeEnv(overrides).env)
}

test('a valid bootstrap assertion yields the typed learner identity', async () => {
  const cfg = cfgFor()
  const learner = await verifyBootstrapAssertion({ cfg, token: await signBootstrap() })
  assert.equal(learner.learnerId, 'learner-1')
  assert.equal(learner.learnerSessionId, 'lsession-1')
  assert.equal(learner.displayName, 'Ada')
  assert.equal(learner.avatarId, 'fox')
  assert.equal(learner.ageYears, 7)
  assert.equal(learner.locale, 'en-IN')
  assert.equal(learner.releaseId, 'chessmaster-dev-release-1')
})

test('wrong shared secret is rejected (fail closed, no throw of raw JWT error)', async () => {
  const cfg = cfgFor()
  const forged = await signBootstrap(LEARNER_CLAIMS, { secret: 'a-different-secret-of-enough-length!!' })
  await assert.rejects(
    () => verifyBootstrapAssertion({ cfg, token: forged }),
    (e) => e instanceof AppLaunchError && e.code === 'BOOTSTRAP_INVALID',
  )
})

test('wrong issuer is rejected', async () => {
  const cfg = cfgFor()
  const token = await signBootstrap(LEARNER_CLAIMS, { issuer: 'https://evil.example' })
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token }), (e) => e.code === 'BOOTSTRAP_INVALID')
})

test('wrong audience (not our client_id) is rejected', async () => {
  const cfg = cfgFor()
  const token = await signBootstrap(LEARNER_CLAIMS, { audience: 'someone-else' })
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token }), (e) => e.code === 'BOOTSTRAP_INVALID')
})

test('an expired assertion is rejected', async () => {
  const cfg = cfgFor()
  const past = Math.floor(Date.now() / 1000) - 3600
  const token = await signBootstrap(LEARNER_CLAIMS, { exp: past })
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token }), (e) => e.code === 'BOOTSTRAP_INVALID')
})

test('an app_id that does not match this deployment is rejected', async () => {
  const cfg = cfgFor()
  const token = await signBootstrap({ ...LEARNER_CLAIMS, app_id: 'some-other-app' })
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token }), (e) => e.code === 'BOOTSTRAP_INVALID')
})

test('an app_key that does not match our client_id is rejected', async () => {
  const cfg = cfgFor()
  const token = await signBootstrap({ ...LEARNER_CLAIMS, app_key: 'not-our-client' })
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token }), (e) => e.code === 'BOOTSTRAP_INVALID')
})

test('missing learner_id is rejected', async () => {
  const cfg = cfgFor()
  const { learner_id, ...noId } = LEARNER_CLAIMS
  const token = await signBootstrap(noId)
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token }), (e) => e.code === 'BOOTSTRAP_INVALID')
})

test('a garbage token string is rejected without throwing a raw error', async () => {
  const cfg = cfgFor()
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token: 'not.a.jwt' }), (e) => e instanceof AppLaunchError)
  await assert.rejects(() => verifyBootstrapAssertion({ cfg, token: '' }), (e) => e instanceof AppLaunchError)
})
