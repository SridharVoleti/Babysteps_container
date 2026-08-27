// Local end-to-end aid for the BabySteps → ChessMaster launch handoff.
//
// Stands up a fake BabySteps exchange endpoint (signs a bootstrap assertion with your dev
// APP_LAUNCH_BOOTSTRAP_SECRET), then POSTs a launch form to your running dev server exactly
// as a parent's browser would. Prints the redirect target + Set-Cookie.
//
// Usage:
//   1. Set the APP_LAUNCH_* vars in .env.local (see .env.example). Point the exchange at
//      this script:  APP_LAUNCH_EXCHANGE_URL=http://localhost:4599/exchange
//   2. npm run dev           (Next dev server on :3000)
//   3. node --env-file=.env.local scripts/simulate-app-launch.mjs
import { createServer } from 'node:http'
import { SignJWT } from 'jose'

const APP_ORIGIN = process.env.SIMULATE_APP_ORIGIN || 'http://localhost:3000'
const EXCHANGE_PORT = Number(new URL(process.env.APP_LAUNCH_EXCHANGE_URL || 'http://localhost:4599/exchange').port || 4599)

const {
  APP_LAUNCH_CLIENT_ID: clientId,
  APP_LAUNCH_BOOTSTRAP_SECRET: secret,
  APP_LAUNCH_APP_ID: appId,
  APP_LAUNCH_BOOTSTRAP_ISSUER: issuer = 'https://babysteps.in',
} = process.env

if (!clientId || !secret || !appId) {
  console.error('Set APP_LAUNCH_CLIENT_ID, APP_LAUNCH_BOOTSTRAP_SECRET and APP_LAUNCH_APP_ID first.')
  process.exit(1)
}

async function bootstrapAssertion() {
  const iat = Math.floor(Date.now() / 1000)
  return new SignJWT({
    learner_session_id: `sim-session-${iat}`,
    learner_id: 'sim-learner-1',
    display_name: 'Sim Learner',
    avatar_id: 'fox',
    age_years: 7,
    locale: 'en-IN',
    learner_timezone: 'Asia/Kolkata',
    app_id: appId,
    app_key: clientId,
    deployment_id: process.env.APP_LAUNCH_DEPLOYMENT_ID,
    release_id: 'chessmaster-dev-release-1',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(new TextEncoder().encode(secret))
}

const exchange = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    console.log('[fake-exchange] app assertion:', req.headers['x-babysteps-app-assertion']?.slice(0, 40), '…')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      bootstrapAssertion: await bootstrapAssertion(),
      bootstrapExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      centralSessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      platformApiAccess: {},
    }))
  })
})

exchange.listen(EXCHANGE_PORT, async () => {
  console.log(`[fake-exchange] listening on :${EXCHANGE_PORT}`)
  const form = new URLSearchParams({ launchCode: 'sim-code-1', launchAttemptId: crypto.randomUUID() })
  const res = await fetch(`${APP_ORIGIN}/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  })
  console.log('[launch] status:', res.status)
  console.log('[launch] location:', res.headers.get('location'))
  console.log('[launch] set-cookie:', res.headers.get('set-cookie'))
  if (res.status >= 400) console.log('[launch] body:', await res.text())
  exchange.close()
})
