// Shared fixtures for the app-launch handoff tests. Simulates the BabySteps side, which the
// container itself has no signing analog to — only a test harness ever holds these keys.
import { generateKeyPairSync } from 'node:crypto'
import { SignJWT, importJWK } from 'jose'

export const CLIENT_ID = 'chessmaster-client'
export const APP_ID = 'chessmaster'
export const BOOTSTRAP_SECRET = 'test-bootstrap-secret-abcdefghijklmnop' // > 32 chars
export const BOOTSTRAP_ISSUER = 'https://babysteps.in'
export const EXCHANGE_URL = 'https://exchange.test/v1/internal/app-launch/exchange'

/** Build a full APP_LAUNCH_* env + the matching public verification key. */
export function makeEnv(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    env: {
      APP_LAUNCH_CLIENT_ID: CLIENT_ID,
      APP_LAUNCH_SIGNING_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
      APP_LAUNCH_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
      APP_LAUNCH_APP_ID: APP_ID,
      APP_LAUNCH_ENVIRONMENT: 'test',
      APP_LAUNCH_DEPLOYMENT_ID: 'deploy-1',
      APP_LAUNCH_EXCHANGE_URL: EXCHANGE_URL,
      APP_LAUNCH_BOOTSTRAP_ISSUER: BOOTSTRAP_ISSUER,
      APP_LAUNCH_RETURN_URL: 'https://return.test',
      APP_LAUNCH_LANDING_PATH: '/apps/chessmaster/fork',
      ...overrides,
    },
    signingPublicJwk: publicKey.export({ format: 'jwk' }),
  }
}

export const LEARNER_CLAIMS = Object.freeze({
  learner_session_id: 'lsession-1',
  learner_id: 'learner-1',
  display_name: 'Ada',
  avatar_id: 'fox',
  age_years: 7,
  age_months: 3,
  locale: 'en-IN',
  learner_timezone: 'Asia/Kolkata',
  app_id: APP_ID,
  app_key: CLIENT_ID,
  deployment_id: 'deploy-1',
  release_id: 'chessmaster-dev-release-1',
})

/** Sign a bootstrap assertion the way BabySteps would (HS256, shared secret). */
export async function signBootstrap(claims = LEARNER_CLAIMS, opts = {}) {
  const secret = new TextEncoder().encode(opts.secret ?? BOOTSTRAP_SECRET)
  const iat = Math.floor((opts.now?.getTime?.() ?? Date.now()) / 1000)
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(opts.issuer ?? BOOTSTRAP_ISSUER)
    .setAudience(opts.audience ?? CLIENT_ID)
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 120)
    .sign(secret)
}

/** Verify an EdDSA app assertion the way BabySteps would. */
export async function verifyAppAssertion(token, publicJwk) {
  const { jwtVerify } = await import('jose')
  const key = await importJWK(publicJwk, 'EdDSA')
  return jwtVerify(token, key, { audience: 'babysteps:app-launch:exchange' })
}

/** A fetch stand-in that returns a JSON body once, capturing the request. */
export function stubFetch(response) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (typeof response === 'function') return response(url, init)
    return response
  }
  impl.calls = calls
  return impl
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** Minimal in-memory AuthzService stand-in for provisioning tests. */
export function fakeAuthz() {
  const state = { students: new Map(), sessions: [], tokens: [] }
  return {
    state,
    async upsertLaunchStudent({ id, displayName }) {
      const s = { id, email: `launch+${id}@apps.babysteps.in`, displayName, createdAt: 'now' }
      state.students.set(id, s)
      return s
    },
    async ensureBookingForToday(studentId) {
      return { id: `booking-${studentId}`, studentId, slotDate: 'today', createdAt: 'now' }
    },
    async startLaunchSession(studentId, opts = {}) {
      const existing = state.sessions.find((s) => s.studentId === studentId && !s.endedAt)
      if (existing) return { session: existing, resumed: true }
      const session = {
        id: `session-${state.sessions.length + 1}`,
        studentId,
        bookingId: `booking-${studentId}`,
        startedAt: 'now',
        expiresAt: opts.sessionExpiresAt ?? 'later',
        endedAt: null,
      }
      state.sessions.push(session)
      return { session, resumed: false }
    },
    async issueToken(studentId, expiresAt) {
      const token = `tok-${studentId}-${state.tokens.length + 1}`
      state.tokens.push({ token, studentId, expiresAt: expiresAt ?? 'ttl' })
      return { token, expiresAt: expiresAt ?? 'ttl' }
    },
  }
}
