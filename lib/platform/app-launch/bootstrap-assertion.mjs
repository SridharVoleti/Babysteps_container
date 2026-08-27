// Step 5 of CHESSMASTER_LAUNCH_INTEGRATION.md: verify the bootstrap assertion BabySteps hands
// back from the exchange, then — and only then — we know who is playing. HS256, signed with
// the shared secret only BabySteps and we hold. Fails closed: any problem yields
// AppLaunchError('BOOTSTRAP_INVALID'), never a partially-trusted learner.

import { jwtVerify } from 'jose'
import { AppLaunchError } from './errors.mjs'

/**
 * @typedef {Object} LearnerBootstrap
 * @property {string} learnerSessionId  key session/progress rows off this
 * @property {string} learnerId         stable id for the child across sessions
 * @property {string} displayName
 * @property {string | undefined} avatarId
 * @property {number | undefined} ageYears
 * @property {number | undefined} ageMonths
 * @property {string | undefined} locale
 * @property {string | undefined} learnerTimezone
 * @property {string | undefined} deploymentId
 * @property {string | undefined} releaseId
 */

/**
 * @param {Object} params
 * @param {import('./config.mjs').AppLaunchConfig} params.cfg
 * @param {string} params.token   the bootstrapAssertion string from the exchange
 * @param {() => Date} [params.now]
 * @returns {Promise<LearnerBootstrap>}
 */
export async function verifyBootstrapAssertion({ cfg, token, now }) {
  if (typeof token !== 'string' || token === '') {
    throw new AppLaunchError('BOOTSTRAP_INVALID', 'Missing bootstrap assertion.')
  }

  const secret = new TextEncoder().encode(cfg.bootstrapSecret)

  let payload
  try {
    ;({ payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      issuer: cfg.bootstrapIssuer,
      audience: cfg.clientId,
      currentDate: now ? now() : undefined,
      clockTolerance: 5,
    }))
  } catch (e) {
    throw new AppLaunchError('BOOTSTRAP_INVALID', `Bootstrap assertion did not verify: ${e instanceof Error ? e.message : 'unknown error'}`)
  }

  // app_id / app_key must match what we were given at onboarding — reject if not.
  if (str(payload.app_id) !== cfg.appId) {
    throw new AppLaunchError('BOOTSTRAP_INVALID', 'Bootstrap assertion app_id does not match this deployment.')
  }
  if (payload.app_key !== undefined && str(payload.app_key) !== cfg.clientId) {
    throw new AppLaunchError('BOOTSTRAP_INVALID', 'Bootstrap assertion app_key does not match this client.')
  }

  const learnerId = str(payload.learner_id)
  const learnerSessionId = str(payload.learner_session_id)
  const displayName = str(payload.display_name)
  if (!learnerId || !learnerSessionId || !displayName) {
    throw new AppLaunchError('BOOTSTRAP_INVALID', 'Bootstrap assertion is missing learner_id, learner_session_id or display_name.')
  }

  return Object.freeze({
    learnerId,
    learnerSessionId,
    displayName,
    avatarId: str(payload.avatar_id) || undefined,
    ageYears: num(payload.age_years),
    ageMonths: num(payload.age_months),
    locale: str(payload.locale) || undefined,
    learnerTimezone: str(payload.learner_timezone) || undefined,
    deploymentId: str(payload.deployment_id) || undefined,
    releaseId: str(payload.release_id) || undefined,
  })
}

function str(v) {
  return typeof v === 'string' ? v : ''
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
