// CR-002: container-owned, version-controlled source of truth for which prior/persisted
// content versions may resume directly into a newer, currently-approved content version for
// a given app. Runtime callers may report what content version a session was previously
// bound to (e.g. from restored SP-002 local state), but only a mapping already recorded
// here - tied to a governance decision - can make that resume compatible. A caller-supplied
// mapping function can never grant approval on its own.
export const CONTENT_VERSION_COMPATIBILITY_REGISTRY = Object.freeze({
  'magical-math': Object.freeze({
    v11: Object.freeze({ compatibleWith: 'v12', governanceDecisionId: 'GOV-CR002-MAGICAL-MATH-V11-V12-001' }),
  }),
});

// Returns the approved content version a resume should bind to, or null when the resume is
// not authorized: either the resumed version already matches the current approved version,
// or a trusted registry entry for this app maps it onto the current approved version.
export function resolveApprovedResumeContentVersion(appId, resumedContentVersion, currentContentVersion) {
  if (resumedContentVersion === currentContentVersion) return currentContentVersion;
  const entry = CONTENT_VERSION_COMPATIBILITY_REGISTRY[appId]?.[resumedContentVersion];
  if (entry && entry.compatibleWith === currentContentVersion) return currentContentVersion;
  return null;
}
