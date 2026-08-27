import test from 'node:test'
import assert from 'node:assert/strict'
import { appLaunchConfig, isAppLaunchConfigured } from '../../lib/platform/app-launch/config.mjs'
import { AppLaunchError } from '../../lib/platform/app-launch/errors.mjs'
import { makeEnv } from './_helpers.mjs'

test('a complete env produces a frozen config with defaults filled in', () => {
  const { env } = makeEnv()
  delete env.APP_LAUNCH_EXCHANGE_URL
  delete env.APP_LAUNCH_BOOTSTRAP_ISSUER
  const cfg = appLaunchConfig(env)
  assert.equal(cfg.exchangeUrl, 'https://www.babystepsindia.com/v1/internal/app-launch/exchange')
  assert.equal(cfg.bootstrapIssuer, 'https://babysteps.in')
  assert.equal(cfg.landingPath, '/apps/chessmaster/fork')
  assert.throws(() => { cfg.clientId = 'x' })
})

test('a missing required var fails closed with LAUNCH_MISCONFIGURED', () => {
  for (const key of [
    'APP_LAUNCH_CLIENT_ID',
    'APP_LAUNCH_SIGNING_PRIVATE_KEY',
    'APP_LAUNCH_BOOTSTRAP_SECRET',
    'APP_LAUNCH_APP_ID',
    'APP_LAUNCH_ENVIRONMENT',
    'APP_LAUNCH_DEPLOYMENT_ID',
  ]) {
    const { env } = makeEnv()
    delete env[key]
    assert.throws(
      () => appLaunchConfig(env),
      (e) => e instanceof AppLaunchError && e.code === 'LAUNCH_MISCONFIGURED',
      `expected ${key} to be required`,
    )
  }
})

test('a non-Ed25519 signing key is rejected', () => {
  const { env } = makeEnv()
  env.APP_LAUNCH_SIGNING_PRIVATE_KEY = JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'x', x: 'y', y: 'z' })
  assert.throws(() => appLaunchConfig(env), (e) => e.code === 'LAUNCH_MISCONFIGURED')
})

test('a short bootstrap secret is rejected', () => {
  const { env } = makeEnv()
  env.APP_LAUNCH_BOOTSTRAP_SECRET = 'too-short'
  assert.throws(() => appLaunchConfig(env), (e) => e.code === 'LAUNCH_MISCONFIGURED')
})

test('isAppLaunchConfigured reflects completeness without throwing', () => {
  const { env } = makeEnv()
  assert.equal(isAppLaunchConfigured(env), true)
  delete env.APP_LAUNCH_CLIENT_ID
  assert.equal(isAppLaunchConfigured(env), false)
})
