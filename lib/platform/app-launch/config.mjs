// APP_LAUNCH_* environment configuration for the BabySteps → ChessMaster browser handoff.
// Read + validated in one place so every consumer fails closed identically on a missing
// secret (SB-001: no valid launch can be processed without full, correct configuration).
//
// Lives under lib/platform/ because it is the only layer allowed to hold these secrets and
// make the outbound call to BabySteps (CC-003).

import { AppLaunchError } from './errors.mjs'

const DEFAULT_EXCHANGE_URL = 'https://www.babystepsindia.com/v1/internal/app-launch/exchange'
const DEFAULT_BOOTSTRAP_ISSUER = 'https://babysteps.in'
const DEFAULT_RETURN_URL = 'https://www.babystepsindia.com'
const DEFAULT_LANDING_PATH = '/apps/chessmaster/fork'

/**
 * @typedef {Object} AppLaunchConfig
 * @property {string} clientId              our client_id, registered with BabySteps
 * @property {import('jose').JWK} signingJwk Ed25519 private JWK — signs the app assertion
 * @property {string} bootstrapSecret       shared HS256 secret — verifies the bootstrap assertion
 * @property {string} appId                 our app_id from onboarding
 * @property {string} environment           our environment from onboarding
 * @property {string} deploymentId          our deployment_id from onboarding
 * @property {string} exchangeUrl           BabySteps' internal exchange endpoint
 * @property {string} bootstrapIssuer       expected `iss` on the bootstrap assertion
 * @property {string} returnUrl             where GET /return sends the learner
 * @property {string} landingPath           in-app path a successful launch redirects to
 */

/**
 * Build the config from environment variables. Throws AppLaunchError('LAUNCH_MISCONFIGURED')
 * if any required value is absent or malformed.
 * @param {Record<string, string | undefined>} [env]
 * @returns {AppLaunchConfig}
 */
export function appLaunchConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AppLaunchError('LAUNCH_MISCONFIGURED', `${name} is required to process an app launch.`)
    }
    return value.trim()
  }

  const clientId = required('APP_LAUNCH_CLIENT_ID')

  let signingJwk
  try {
    signingJwk = JSON.parse(required('APP_LAUNCH_SIGNING_PRIVATE_KEY'))
  } catch {
    throw new AppLaunchError('LAUNCH_MISCONFIGURED', 'APP_LAUNCH_SIGNING_PRIVATE_KEY must be an Ed25519 private key JWK (JSON).')
  }
  if (!signingJwk || signingJwk.kty !== 'OKP' || signingJwk.crv !== 'Ed25519' || typeof signingJwk.d !== 'string') {
    throw new AppLaunchError('LAUNCH_MISCONFIGURED', 'APP_LAUNCH_SIGNING_PRIVATE_KEY must be an Ed25519 (OKP/Ed25519) private JWK.')
  }

  const bootstrapSecret = required('APP_LAUNCH_BOOTSTRAP_SECRET')
  if (bootstrapSecret.length < 32) {
    throw new AppLaunchError('LAUNCH_MISCONFIGURED', 'APP_LAUNCH_BOOTSTRAP_SECRET must be at least 32 characters.')
  }

  return Object.freeze({
    clientId,
    signingJwk: Object.freeze(signingJwk),
    bootstrapSecret,
    appId: required('APP_LAUNCH_APP_ID'),
    environment: required('APP_LAUNCH_ENVIRONMENT'),
    deploymentId: required('APP_LAUNCH_DEPLOYMENT_ID'),
    exchangeUrl: env.APP_LAUNCH_EXCHANGE_URL?.trim() || DEFAULT_EXCHANGE_URL,
    bootstrapIssuer: env.APP_LAUNCH_BOOTSTRAP_ISSUER?.trim() || DEFAULT_BOOTSTRAP_ISSUER,
    returnUrl: env.APP_LAUNCH_RETURN_URL?.trim() || DEFAULT_RETURN_URL,
    landingPath: env.APP_LAUNCH_LANDING_PATH?.trim() || DEFAULT_LANDING_PATH,
  })
}

/** True when enough APP_LAUNCH_* config is present to even attempt a launch. */
export function isAppLaunchConfigured(env = process.env) {
  try {
    appLaunchConfig(env)
    return true
  } catch {
    return false
  }
}
