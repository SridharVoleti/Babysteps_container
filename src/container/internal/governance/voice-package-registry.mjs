// AM-002/PK-003: container-owned, version-controlled registry of the approved packaged
// narration voice for each Babysteps release. Keyed by the PK-003 release-composition
// `voicePackageVersion` component identifier, so the exact voice package/fallbacks used by
// AM-002 is always traceable to (and cannot drift from) the release actually shipped.
// Runtime callers can request narration, but only an entry already recorded here can supply
// the primary/fallback voice packages that get loaded - a caller cannot self-approve a voice
// package by constructing one locally.
export const VOICE_PACKAGE_REGISTRY = Object.freeze({
  '1.0.0': Object.freeze({
    voicePackage: Object.freeze({ id: 'babysteps-standard-voice', version: '1.0.0' }),
    approvedFallbackVoices: Object.freeze({
      LOAD_FAILED: Object.freeze({ id: 'babysteps-accessibility-fallback-voice', version: '1.0.0' }),
    }),
  }),
});

export function resolveApprovedNarrationVoice(voicePackageVersion) {
  return VOICE_PACKAGE_REGISTRY[voicePackageVersion] ?? null;
}

// PK-003: the single voicePackageVersion the release composition/conformance gate reports
// as "the packaged voice" for this container release.
export const CURRENT_VOICE_PACKAGE_VERSION = '1.0.0';
