// Error type + HTTP status mapping for the BabySteps → app browser handoff
// (see CHESSMASTER_LAUNCH_INTEGRATION.md). Every failure in this module is expressed as an
// AppLaunchError so the /launch route can fail closed with a safe, non-leaking response.

export class AppLaunchError extends Error {
  /**
   * @param {AppLaunchErrorCode} code
   * @param {string} message  developer-facing; never rendered to the browser verbatim
   */
  constructor(code, message) {
    super(message)
    this.name = 'AppLaunchError'
    this.code = code
    Object.freeze(this)
  }
}

/**
 * @typedef {'LAUNCH_MISCONFIGURED'
 *   | 'BAD_LAUNCH_REQUEST'
 *   | 'EXCHANGE_FAILED'
 *   | 'BOOTSTRAP_INVALID'
 *   | 'PROVISION_FAILED'} AppLaunchErrorCode
 */

/** @type {Record<AppLaunchErrorCode, number>} */
export const ERROR_STATUS = Object.freeze({
  LAUNCH_MISCONFIGURED: 500,
  BAD_LAUNCH_REQUEST: 400,
  EXCHANGE_FAILED: 502,
  BOOTSTRAP_INVALID: 502,
  PROVISION_FAILED: 500,
})

/** Short, safe sentence shown to the parent's browser for each failure class. */
export const ERROR_MESSAGE = Object.freeze({
  LAUNCH_MISCONFIGURED: 'ChessMaster is not configured to accept launches yet.',
  BAD_LAUNCH_REQUEST: 'This launch link is missing information and cannot be opened.',
  EXCHANGE_FAILED: 'ChessMaster could not confirm this launch with BabySteps. Please try again.',
  BOOTSTRAP_INVALID: 'ChessMaster could not verify who is launching. Please try again.',
  PROVISION_FAILED: 'ChessMaster could not start a session. Please try again.',
})
