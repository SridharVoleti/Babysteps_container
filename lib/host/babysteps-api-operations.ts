// API-003: the typed operation contracts the host layer's createBabystepsApiClient uses to
// call the Babysteps Platform API (app/api/v1/**) — the only HTTP surface the host is allowed
// to reach (CC-003: no direct Supabase access from host/runtime code). Each operation's
// method/path must match its route handler exactly; each parseResponse is built with the
// container's own defineApiContract (src/container/internal/api/contract-validation.mjs), so
// a malformed/incompatible platform response fails closed the same way any other container
// capability failure does.
// Namespace import + `any` cast avoids TypeScript's structural inference over this untyped
// .mjs module's default-parameter shapes (see lib/host/bootstrap-chessmaster.ts for the same
// pattern/rationale).
import * as ContractValidationModule from '../../src/container/internal/api/contract-validation.mjs'
const defineApiContract: any = (ContractValidationModule as any).defineApiContract

const CONTRACT_VERSION = '1.0'

const progressCheckpointContract = defineApiContract({
  operation: 'progress.checkpoint',
  supportedVersions: [CONTRACT_VERSION],
  fields: {
    acknowledged: { required: true, type: 'boolean' },
    progressVersion: { required: false, type: 'string' },
    conflict: { required: false, type: 'boolean' },
  },
  mapToDomain: (raw: any) => ({
    acknowledged: raw.acknowledged,
    progressVersion: raw.progressVersion ?? null,
    conflict: raw.conflict === true,
  }),
})

const progressRestoreContract = defineApiContract({
  operation: 'progress.restore',
  supportedVersions: [CONTRACT_VERSION],
  fields: {
    found: { required: true, type: 'boolean' },
  },
  mapToDomain: (raw: any) => ({
    found: raw.found,
    progressVersion: raw.progressVersion ?? null,
    appProgressSchemaVersion: raw.appProgressSchemaVersion ?? null,
    appProgress: raw.appProgress ?? null,
  }),
})

const sessionFinalizeContract = defineApiContract({
  operation: 'session.finalize',
  supportedVersions: [CONTRACT_VERSION],
  fields: {
    finalStatus: { required: true, type: 'string' },
  },
  mapToDomain: (raw: any) => ({ finalStatus: raw.finalStatus }),
})

export const BABYSTEPS_API_OPERATIONS = Object.freeze({
  'progress.checkpoint': {
    method: 'POST',
    path: '/api/v1/progress/checkpoint',
    authorityFields: ['learnerId', 'appId', 'releaseId', 'sessionId'],
    idempotent: true,
    parseResponse: progressCheckpointContract.parseResponse,
  },
  // Reuses the checkpoint endpoint/contract: SR-004's createFinalizationAdapter calls
  // 'progress.save' with the final progress payload immediately before 'session.finalize' —
  // same persistence semantics as an ordinary PA-001 checkpoint.
  'progress.save': {
    method: 'POST',
    path: '/api/v1/progress/checkpoint',
    authorityFields: ['learnerId', 'appId', 'releaseId', 'sessionId'],
    idempotent: true,
    parseResponse: progressCheckpointContract.parseResponse,
  },
  'progress.restore': {
    method: 'POST',
    path: '/api/v1/progress/restore',
    authorityFields: ['learnerId', 'appId', 'releaseId'],
    parseResponse: progressRestoreContract.parseResponse,
  },
  'session.finalize': {
    method: 'POST',
    path: '/api/v1/session-finalize',
    authorityFields: ['learnerId', 'releaseId', 'sessionId'],
    idempotent: true,
    parseResponse: sessionFinalizeContract.parseResponse,
  },
})
