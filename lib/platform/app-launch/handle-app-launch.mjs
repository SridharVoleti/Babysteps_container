// Orchestrates the whole POST /launch flow from CHESSMASTER_LAUNCH_INTEGRATION.md:
//   form body  ->  exchange launch code  ->  verify bootstrap assertion  ->  start session
// Framework-agnostic (no next/server import) so it is directly testable under node:test. The
// route handler (app/launch/route.ts) turns the result into a NextResponse + auth cookie.
//
// Never throws: every failure comes back as { ok: false, ... } so the route fails closed.

import { AppLaunchError, ERROR_STATUS, ERROR_MESSAGE } from './errors.mjs'
import { exchangeLaunchCode } from './exchange.mjs'
import { verifyBootstrapAssertion } from './bootstrap-assertion.mjs'
import { provisionLaunchSession } from './provision-launch-session.mjs'

/**
 * @param {Object} params
 * @param {string} params.rawBody   the application/x-www-form-urlencoded request body
 * @param {import('./config.mjs').AppLaunchConfig} params.cfg
 * @param {import('../authz/service').AuthzService} params.authz
 * @param {typeof fetch} [params.fetchImpl]
 * @param {() => Date} [params.now]
 * @returns {Promise<
 *   | { ok: true, redirectTo: string, token: string, tokenExpiresAt: string, sessionId: string,
 *       learner: import('./bootstrap-assertion.mjs').LearnerBootstrap, resumed: boolean }
 *   | { ok: false, code: string, status: number, message: string }
 * >}
 */
export async function handleAppLaunch({ rawBody, cfg, authz, fetchImpl = fetch, now }) {
  try {
    const form = new URLSearchParams(typeof rawBody === 'string' ? rawBody : '')
    const launchCode = form.get('launchCode') ?? ''
    const launchAttemptId = form.get('launchAttemptId') ?? ''
    if (!launchCode || !launchAttemptId) {
      throw new AppLaunchError('BAD_LAUNCH_REQUEST', 'launchCode and launchAttemptId form fields are required.')
    }

    const exchange = await exchangeLaunchCode({ cfg, launchCode, launchAttemptId, fetchImpl, now })
    const learner = await verifyBootstrapAssertion({ cfg, token: exchange.bootstrapAssertion, now })
    const provisioned = await provisionLaunchSession({
      authz,
      learner,
      centralSessionExpiresAt: exchange.centralSessionExpiresAt,
    })

    return {
      ok: true,
      redirectTo: cfg.landingPath,
      token: provisioned.token,
      tokenExpiresAt: provisioned.tokenExpiresAt,
      sessionId: provisioned.sessionId,
      learner,
      resumed: provisioned.resumed,
    }
  } catch (e) {
    const code = e instanceof AppLaunchError ? e.code : 'PROVISION_FAILED'
    // Developer-facing detail to the server log; only the safe sentence goes to the browser.
    console.error('[app-launch] launch failed:', code, e instanceof Error ? e.message : e)
    return {
      ok: false,
      code,
      status: ERROR_STATUS[code] ?? 500,
      message: ERROR_MESSAGE[code] ?? 'ChessMaster could not open this launch.',
    }
  }
}
