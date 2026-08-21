// AM-001/AM-002/AM-003/SP-001-P1: privacy-limited telemetry must never include a raw
// exception message from a player/provider/adapter/recognizer failure - the underlying
// browser/OS/vendor error can echo learner content (narration text, transcripts,
// notification payloads) or other request context. Every emitted `cause` is reduced to a
// fixed technical code: the failing module's own typed error `code` when present (already a
// safe enum-like category), otherwise a generic fallback - never the raw message.
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function sanitizeCause(error, fallbackCode = 'ADAPTER_OPERATION_FAILED') {
  return typeof error?.code === 'string' && SAFE_CODE_PATTERN.test(error.code) ? error.code : fallbackCode;
}
