// Step 2 of CHESSMASTER_LAUNCH_INTEGRATION.md: trade the one-time launch code for a bootstrap
// assertion over a signed, server-to-server call to BabySteps. Any failure fails closed —
// the caller must never fall back to trusting anything from the browser.

import { randomUUID } from 'node:crypto'
import { AppLaunchError } from './errors.mjs'
import { mintAppAssertion } from './app-assertion.mjs'

/**
 * @typedef {Object} ExchangeResult
 * @property {string} bootstrapAssertion       HS256 JWT — verify before trusting
 * @property {string} [bootstrapExpiresAt]
 * @property {string} [centralSessionExpiresAt]
 * @property {unknown} [platformApiAccess]
 */

/**
 * @param {Object} params
 * @param {import('./config.mjs').AppLaunchConfig} params.cfg
 * @param {string} params.launchCode
 * @param {string} params.launchAttemptId
 * @param {typeof fetch} [params.fetchImpl]
 * @param {() => Date} [params.now]
 * @returns {Promise<ExchangeResult>}
 */
export async function exchangeLaunchCode({ cfg, launchCode, launchAttemptId, fetchImpl = fetch, now }) {
  if (!launchCode || !launchAttemptId) {
    throw new AppLaunchError('BAD_LAUNCH_REQUEST', 'launchCode and launchAttemptId are both required.')
  }

  const assertion = await mintAppAssertion(cfg, { now })

  let res
  try {
    res = await fetchImpl(cfg.exchangeUrl, {
      method: 'POST',
      headers: {
        'x-babysteps-app-assertion': assertion,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        launchCode,
        launchAttemptId,
        exchangeIdempotencyKey: randomUUID(),
      }),
      cache: 'no-store',
    })
  } catch (e) {
    throw new AppLaunchError('EXCHANGE_FAILED', `Exchange request failed: ${e instanceof Error ? e.message : 'network error'}`)
  }

  if (!res.ok) {
    const detail = await safeText(res)
    throw new AppLaunchError('EXCHANGE_FAILED', `Exchange endpoint returned ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  let body
  try {
    body = await res.json()
  } catch {
    throw new AppLaunchError('EXCHANGE_FAILED', 'Exchange endpoint returned a non-JSON body.')
  }

  if (!body || typeof body.bootstrapAssertion !== 'string' || body.bootstrapAssertion === '') {
    throw new AppLaunchError('EXCHANGE_FAILED', 'Exchange response did not include a bootstrapAssertion.')
  }

  return Object.freeze({
    bootstrapAssertion: body.bootstrapAssertion,
    bootstrapExpiresAt: typeof body.bootstrapExpiresAt === 'string' ? body.bootstrapExpiresAt : undefined,
    centralSessionExpiresAt: typeof body.centralSessionExpiresAt === 'string' ? body.centralSessionExpiresAt : undefined,
    platformApiAccess: body.platformApiAccess,
  })
}

async function safeText(res) {
  try {
    const t = await res.text()
    return t.slice(0, 200)
  } catch {
    return ''
  }
}
