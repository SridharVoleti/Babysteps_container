const REQUIRED_CLAIMS = ['learnerId','appId','releaseId','sessionId','launchMode','issuedAt','expiresAt','correlationId'];
const ALLOWED_MODES = new Set(['start','resume']);

// Centralized, documented clock-skew tolerance for launch-context issuance (SB-001).
// A launch context issued more than this far in the future (relative to the container's
// own clock) is rejected; callers cannot opt out of or widen this tolerance.
export const MAX_FUTURE_ISSUANCE_SKEW_MS = 60_000;

export class LaunchContextError extends Error {
  constructor(code, message) { super(message); this.name = 'LaunchContextError'; this.code = code; Object.freeze(this); }
}

function fail(code, message) { throw new LaunchContextError(code, message); }
function nonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

export async function validateLaunchContext({ launchContext, manifest, expectedReleaseId, expectedSessionId, verifier, now = () => new Date() }) {
  if (!launchContext) fail('LAUNCH_CONTEXT_MISSING', 'Authorized launch context is required.');
  if (!launchContext.claims || typeof launchContext.claims !== 'object' || typeof verifier !== 'function') fail('LAUNCH_CONTEXT_INVALID', 'Authorized launch context is invalid.');

  let verification;
  try { verification = await verifier(launchContext); } catch { fail('LAUNCH_CONTEXT_INVALID', 'Authorized launch context could not be verified.'); }
  if (!verification?.ok || !verification.claims || typeof verification.claims !== 'object') fail('LAUNCH_CONTEXT_INVALID', 'Authorized launch context could not be verified.');
  const claims = verification.claims;

  for (const field of REQUIRED_CLAIMS) if (!nonEmptyString(claims[field])) fail('LAUNCH_CONTEXT_INVALID', 'Authorized launch context is malformed.');
  if (!ALLOWED_MODES.has(claims.launchMode)) fail('LAUNCH_CONTEXT_INVALID', 'Authorized launch mode is invalid.');

  const issuedAt = Date.parse(claims.issuedAt); const expiresAt = Date.parse(claims.expiresAt); const current = now().getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) fail('LAUNCH_CONTEXT_INVALID', 'Authorized launch timestamps are invalid.');
  if (issuedAt > current + MAX_FUTURE_ISSUANCE_SKEW_MS) fail('LAUNCH_CONTEXT_NOT_YET_VALID', 'Authorized launch context is issued too far in the future.');
  if (current >= expiresAt) fail('LAUNCH_CONTEXT_EXPIRED', 'Authorized launch context has expired.');

  if (!manifest || claims.appId !== manifest.appId) fail('LAUNCH_CONTEXT_MISMATCH', 'Authorized app does not match resolved application.');
  if (expectedReleaseId && claims.releaseId !== expectedReleaseId) fail('LAUNCH_CONTEXT_MISMATCH', 'Authorized release does not match resolved release.');
  if (expectedSessionId && claims.sessionId !== expectedSessionId) fail('LAUNCH_CONTEXT_MISMATCH', 'Authorized session does not match expected session.');

  return Object.freeze({
    learnerId: claims.learnerId,
    appId: claims.appId,
    releaseId: claims.releaseId,
    sessionId: claims.sessionId,
    launchMode: claims.launchMode,
    issuedAt: claims.issuedAt,
    correlationId: claims.correlationId
  });
}

export async function bootstrapAuthorizedLaunch({ loadApp, ...validation }) {
  const runtimeContext = await validateLaunchContext(validation);
  if (typeof loadApp !== 'function') fail('LAUNCH_CONTEXT_INVALID', 'Application loader is unavailable.');
  const app = await loadApp(runtimeContext);
  return Object.freeze({ runtimeContext, app });
}
