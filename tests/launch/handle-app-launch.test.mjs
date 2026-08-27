import test from 'node:test'
import assert from 'node:assert/strict'
import { appLaunchConfig } from '../../lib/platform/app-launch/config.mjs'
import { handleAppLaunch } from '../../lib/platform/app-launch/handle-app-launch.mjs'
import {
  makeEnv, signBootstrap, LEARNER_CLAIMS, fakeAuthz, stubFetch, jsonResponse,
} from './_helpers.mjs'

function form(fields) {
  return new URLSearchParams(fields).toString()
}

async function happyFetch(claims = LEARNER_CLAIMS) {
  return stubFetch(jsonResponse({
    bootstrapAssertion: await signBootstrap(claims),
    centralSessionExpiresAt: '2026-08-27T11:32:00.000Z',
  }))
}

test('happy path: exchanges, verifies, provisions, and redirects with a token', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const authz = fakeAuthz()
  const result = await handleAppLaunch({
    rawBody: form({ launchCode: 'code-1', launchAttemptId: 'attempt-1' }),
    cfg, authz, fetchImpl: await happyFetch(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.redirectTo, '/apps/chessmaster/fork')
  assert.equal(result.learner.learnerId, 'learner-1')
  assert.ok(result.token)
  assert.equal(result.sessionId, 'session-1')

  // provisioned into the authz authority
  assert.ok(authz.state.students.has('learner-1'))
  assert.equal(authz.state.sessions.length, 1)
  assert.equal(authz.state.sessions[0].expiresAt, '2026-08-27T11:32:00.000Z')
  assert.equal(authz.state.tokens[0].token, result.token)
})

test('missing form fields → 400, no exchange, no provisioning', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const authz = fakeAuthz()
  const fetchImpl = stubFetch(jsonResponse({ bootstrapAssertion: 'x' }))

  const result = await handleAppLaunch({
    rawBody: form({ launchCode: 'code-1' }), cfg, authz, fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(result.code, 'BAD_LAUNCH_REQUEST')
  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(authz.state.students.size, 0)
})

test('exchange failure → fail closed, no session, no token', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const authz = fakeAuthz()
  const result = await handleAppLaunch({
    rawBody: form({ launchCode: 'c', launchAttemptId: 'a' }),
    cfg, authz, fetchImpl: stubFetch(jsonResponse({ error: 'no' }, 500)),
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXCHANGE_FAILED')
  assert.equal(authz.state.sessions.length, 0)
  assert.equal(authz.state.tokens.length, 0)
})

test('bootstrap assertion for a different app_id → rejected, no session', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const authz = fakeAuthz()
  const result = await handleAppLaunch({
    rawBody: form({ launchCode: 'c', launchAttemptId: 'a' }),
    cfg, authz, fetchImpl: await happyFetch({ ...LEARNER_CLAIMS, app_id: 'other-app' }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'BOOTSTRAP_INVALID')
  assert.equal(authz.state.students.size, 0)
})

test('never throws — a thrown authz error still comes back as { ok: false }', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const brokenAuthz = {
    async upsertLaunchStudent() { throw new Error('db down') },
  }
  const result = await handleAppLaunch({
    rawBody: form({ launchCode: 'c', launchAttemptId: 'a' }),
    cfg, authz: brokenAuthz, fetchImpl: await happyFetch(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PROVISION_FAILED')
  assert.equal(result.status, 500)
})

test('a second launch for the same learner resumes rather than stacking sessions', async () => {
  const cfg = appLaunchConfig(makeEnv().env)
  const authz = fakeAuthz()
  const body = form({ launchCode: 'c', launchAttemptId: 'a' })

  await handleAppLaunch({ rawBody: body, cfg, authz, fetchImpl: await happyFetch() })
  const second = await handleAppLaunch({ rawBody: body, cfg, authz, fetchImpl: await happyFetch() })

  assert.equal(second.ok, true)
  assert.equal(second.resumed, true)
  assert.equal(authz.state.sessions.length, 1)
})
