import test from 'node:test'
import assert from 'node:assert/strict'
import { appLaunchConfig } from '../../lib/platform/app-launch/config.mjs'
import { exchangeLaunchCode } from '../../lib/platform/app-launch/exchange.mjs'
import { AppLaunchError } from '../../lib/platform/app-launch/errors.mjs'
import { makeEnv, stubFetch, jsonResponse, verifyAppAssertion, EXCHANGE_URL } from './_helpers.mjs'

test('posts the assertion header + idempotency key and returns the bootstrap assertion', async () => {
  const { env, signingPublicJwk } = makeEnv()
  const cfg = appLaunchConfig(env)
  const fetchImpl = stubFetch(jsonResponse({
    bootstrapAssertion: 'the-jwt',
    bootstrapExpiresAt: '2026-08-27T10:32:00.000Z',
    centralSessionExpiresAt: '2026-08-27T11:32:00.000Z',
    platformApiAccess: { scope: 'x' },
  }))

  const result = await exchangeLaunchCode({
    cfg, launchCode: 'code-1', launchAttemptId: 'attempt-1', fetchImpl,
  })

  assert.equal(result.bootstrapAssertion, 'the-jwt')
  assert.equal(result.centralSessionExpiresAt, '2026-08-27T11:32:00.000Z')

  assert.equal(fetchImpl.calls.length, 1)
  const { url, init } = fetchImpl.calls[0]
  assert.equal(url, EXCHANGE_URL)
  assert.equal(init.method, 'POST')
  const body = JSON.parse(init.body)
  assert.equal(body.launchCode, 'code-1')
  assert.equal(body.launchAttemptId, 'attempt-1')
  assert.match(body.exchangeIdempotencyKey, /^[0-9a-f-]{36}$/)

  // the header is a real, verifiable EdDSA assertion
  const { payload } = await verifyAppAssertion(init.headers['x-babysteps-app-assertion'], signingPublicJwk)
  assert.equal(payload.app_id, 'chessmaster')
})

test('a non-2xx response fails closed', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const fetchImpl = stubFetch(jsonResponse({ error: 'nope' }, 403))
  await assert.rejects(
    () => exchangeLaunchCode({ cfg, launchCode: 'c', launchAttemptId: 'a', fetchImpl }),
    (e) => e instanceof AppLaunchError && e.code === 'EXCHANGE_FAILED',
  )
})

test('a non-JSON body fails closed', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const fetchImpl = stubFetch({
    ok: true, status: 200,
    json: async () => { throw new Error('not json') },
    text: async () => 'oops',
  })
  await assert.rejects(
    () => exchangeLaunchCode({ cfg, launchCode: 'c', launchAttemptId: 'a', fetchImpl }),
    (e) => e.code === 'EXCHANGE_FAILED',
  )
})

test('a 200 without bootstrapAssertion fails closed', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const fetchImpl = stubFetch(jsonResponse({ somethingElse: true }))
  await assert.rejects(
    () => exchangeLaunchCode({ cfg, launchCode: 'c', launchAttemptId: 'a', fetchImpl }),
    (e) => e.code === 'EXCHANGE_FAILED',
  )
})

test('a network error fails closed', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(
    () => exchangeLaunchCode({ cfg, launchCode: 'c', launchAttemptId: 'a', fetchImpl }),
    (e) => e.code === 'EXCHANGE_FAILED',
  )
})

test('missing launch fields are rejected before any network call', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const fetchImpl = stubFetch(jsonResponse({ bootstrapAssertion: 'x' }))
  await assert.rejects(
    () => exchangeLaunchCode({ cfg, launchCode: '', launchAttemptId: 'a', fetchImpl }),
    (e) => e.code === 'BAD_LAUNCH_REQUEST',
  )
  assert.equal(fetchImpl.calls.length, 0)
})
