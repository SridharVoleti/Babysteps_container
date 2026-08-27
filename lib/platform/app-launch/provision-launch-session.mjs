// Step 5 (continued) of CHESSMASTER_LAUNCH_INTEGRATION.md: "start your own session for the
// child". Bridges a verified LearnerBootstrap into the container's learner/session authority
// (lib/platform/authz) — a real students row + a booking for today + a usage_sessions row —
// then mints the bearer token the browser cookie carries. Downstream (the play gate, the
// SB-001 launch issuer) then works unchanged.

import { AppLaunchError } from './errors.mjs'

/**
 * @param {Object} params
 * @param {import('../authz/service').AuthzService} params.authz  injected AuthzService
 * @param {import('./bootstrap-assertion.mjs').LearnerBootstrap} params.learner
 * @param {string} [params.centralSessionExpiresAt]  ISO — BabySteps-owned session ceiling
 * @returns {Promise<{ token: string, tokenExpiresAt: string, sessionId: string, studentId: string, resumed: boolean }>}
 */
export async function provisionLaunchSession({ authz, learner, centralSessionExpiresAt }) {
  try {
    const student = await authz.upsertLaunchStudent({
      id: learner.learnerId,
      displayName: learner.displayName,
    })
    const { session, resumed } = await authz.startLaunchSession(student.id, {
      sessionExpiresAt: centralSessionExpiresAt,
    })
    const auth = await authz.issueToken(student.id, centralSessionExpiresAt)
    return {
      token: auth.token,
      tokenExpiresAt: auth.expiresAt,
      sessionId: session.id,
      studentId: student.id,
      resumed,
    }
  } catch (e) {
    if (e instanceof AppLaunchError) throw e
    throw new AppLaunchError('PROVISION_FAILED', `Could not provision a launch session: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}
