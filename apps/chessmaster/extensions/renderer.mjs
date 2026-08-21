// CC-004 approved-extension-point registration for ChessMaster's app-specific presentation
// layer (the existing Next.js/React UI: components/GameBoard.tsx, FeedbackPanel.tsx,
// Celebration.tsx, Reveal.tsx). The container has exactly one approved extension type for
// this purpose today — 'activity-renderer' (GOV-CC004-ACTIVITY-RENDERER-001, see
// src/container/internal/governance/extension-registry.mjs) — and it is intentionally opaque:
// the container never inspects what the extension renders, only that it was approved before
// its module executed (extensions/index.mjs#loadApprovedExtensionModule).
//
// This module documents/registers the extension; it does not itself render anything. See
// ../README.md ("UI/presentation gap") for why the browser-hosted React tree is not wired up
// in this vertical slice.
export default Object.freeze({
  id: 'chessmaster-board-ui',
  type: 'activity-renderer',
  version: '1.0',
  async initialize({ runtimeContext } = {}) {
    void runtimeContext;
    // Production wiring: mount ChessMaster's existing Next.js React tree (GameBoard +
    // FeedbackPanel + Celebration + Reveal) here, driving it off the activity implementation
    // returned by chessPatternTrainingActivity.create() (src/activity.mjs) — i.e. calling
    // .attemptMove() on learner input and rendering the returned ValidationResult. No new UI
    // logic belongs in this file; it only hands the container-approved lifecycle hook to the
    // app's existing, unmodified presentation code.
    return Object.freeze({
      dispose() {},
    });
  },
});
