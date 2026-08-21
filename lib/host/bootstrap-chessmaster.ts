// Host/composition layer for the chessmaster activity — the Next.js equivalent of
// scripts/run-chessmaster-demo.mjs and tests/integration/chessmaster-vertical-slice.test.mjs,
// wired to the real Babysteps Platform API (app/api/v1/**) over HTTP instead of fakes. This
// file is the only place allowed to import container internals + apps/chessmaster together;
// it never imports lib/platform/** (Supabase access), only calls it over fetch (CC-003).
//
// Statelessness note: each Vercel invocation is a fresh process, so the activity's in-memory
// attemptNumber cannot be trusted to survive between requests. The caller (the runtime route)
// tracks attemptNumber client-side (mirroring GamePage.tsx's existing attemptRef pattern) and
// passes it back in as resumeAttemptNumber each call — see apps/chessmaster/src/activity.mjs.
import manifestJson from '../../apps/chessmaster/app.manifest.json'
// Statically imported (not dynamic import()) so Vercel's bundler traces & includes it.
import * as ChessmasterAppModule from '../../apps/chessmaster/index.mjs'

// Container-internal modules are plain, untyped ESM (no .d.ts). TypeScript still performs
// structural inference on them from allowJs (e.g. it infers callback-prop types from a
// function's default-parameter shape), which produces false-positive type errors at call
// sites. Importing as `* as X` and casting the whole namespace to `any` up front avoids that
// inference entirely, rather than fighting it call-by-call.
import * as AtomicBootstrapModule from '../../src/container/internal/bootstrap/atomic-bootstrap.mjs'
import * as RuntimeIdentityModule from '../../src/container/internal/runtime/authorized-runtime-identity.mjs'
import * as SessionLifecycleModule from '../../src/container/internal/session/session-lifecycle.mjs'
import * as SessionCompletionModule from '../../src/container/internal/session/session-completion.mjs'
import * as ActivityLifecycleModule from '../../src/container/internal/activities/activity-lifecycle-manager.mjs'
import * as ProgressAdapterModule from '../../src/container/internal/progress/progress-adapter.mjs'
import * as ApiClientModule from '../../src/container/internal/api/babysteps-api-client.mjs'
import * as AuthContextModule from '../../src/container/internal/api/authenticated-request-context.mjs'
import { BABYSTEPS_API_OPERATIONS } from './babysteps-api-operations'

const chessmasterApp: any = (ChessmasterAppModule as any).default
const bootstrapLearningApp: any = (AtomicBootstrapModule as any).bootstrapLearningApp
const getRuntimeContext: any = (RuntimeIdentityModule as any).getRuntimeContext
const createSessionLifecycle: any = (SessionLifecycleModule as any).createSessionLifecycle
const createSessionCompletion: any = (SessionCompletionModule as any).createSessionCompletion
const createFinalizationAdapter: any = (SessionCompletionModule as any).createFinalizationAdapter
const createActivityLifecycleManager: any = (ActivityLifecycleModule as any).createActivityLifecycleManager
const createProgressAdapter: any = (ProgressAdapterModule as any).createProgressAdapter
const createBabystepsApiClient: any = (ApiClientModule as any).createBabystepsApiClient
const createAuthenticatedRequestContext: any = (AuthContextModule as any).createAuthenticatedRequestContext
const createProtectedApiClient: any = (AuthContextModule as any).createProtectedApiClient

const VIRTUAL_MANIFEST_PATH = '/virtual/apps/chessmaster/app.manifest.json'

export interface LaunchEnvelope {
  claims: {
    learnerId: string
    appId: string
    releaseId: string
    sessionId: string
    launchMode: 'start' | 'resume'
    issuedAt: string
    expiresAt: string
    correlationId: string
  }
  proof: string
}

export interface RunAttemptParams {
  baseUrl: string
  cookieHeader: string
  launch: LaunchEnvelope
  puzzle: unknown
  playerMoveUci: string
  resumeAttemptNumber: number
}

function transportFor(cookieHeader: string) {
  return async function transport(requestEnvelope: { method: string; url: string; headers: Record<string, string>; body: unknown }) {
    const res = await fetch(requestEnvelope.url, {
      method: requestEnvelope.method,
      headers: {
        ...requestEnvelope.headers,
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify(requestEnvelope.body ?? {}),
    })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  }
}

/**
 * Runs the container's full SB-001 → SB-003 → AH-002 → PA-001/SR-004 pipeline for exactly one
 * learner move attempt against the chessmaster pattern-training activity, backed by the real
 * Babysteps Platform API. Mirrors tests/integration/chessmaster-vertical-slice.test.mjs and
 * scripts/run-chessmaster-demo.mjs, with a real HTTP transport instead of fakes.
 */
export async function runChessmasterAttempt(params: RunAttemptParams): Promise<any> {
  const { baseUrl, cookieHeader, launch, puzzle, playerMoveUci, resumeAttemptNumber } = params

  const { readiness, appDefinition } = await bootstrapLearningApp({
    manifestPath: VIRTUAL_MANIFEST_PATH,
    readManifestText: async () => JSON.stringify(manifestJson),
    loadModule: async () => ({ default: chessmasterApp }),
    launchContext: launch,
    launchOptions: {
      expectedReleaseId: launch.claims.releaseId,
      expectedSessionId: launch.claims.sessionId,
    },
    capabilityAdapters: { progress: { version: '1.0' } },
    coreServices: [],
  })

  const identity = getRuntimeContext(readiness.runtime)
  const transport = transportFor(cookieHeader)
  const apiClient = createBabystepsApiClient({
    baseUrl,
    contractVersion: '1.0',
    transport,
    authProvider: async () => 'cookie-authenticated',
    runtimeBinding: readiness.runtime,
    operations: BABYSTEPS_API_OPERATIONS,
  })
  const authContext = createAuthenticatedRequestContext({
    resolveToken: async () => ({ token: 'cookie-authenticated', expiresAt: Date.now() + 3_600_000 }),
    refreshToken: async () => ({ token: 'cookie-authenticated', expiresAt: Date.now() + 3_600_000 }),
  })
  const protectedClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: readiness.runtime })

  const progressAdapter = createProgressAdapter({ sessionIdentity: identity, progressClient: protectedClient })
  const finalizationAdapter = createFinalizationAdapter({ progressClient: protectedClient, finalizationClient: protectedClient })
  const lifecycle = createSessionLifecycle({ sessionIdentity: identity, sessionAdapter: finalizationAdapter })
  const completion = createSessionCompletion({ sessionIdentity: identity, lifecycle })

  const manager = createActivityLifecycleManager({
    runtimeBinding: readiness.runtime,
    lifecycle,
    completion,
    onMeaningfulProgress: async (payload: Record<string, unknown>) => {
      await progressAdapter.checkpoint(
        { patternKey: payload.patternKey, xpAwarded: payload.xpAwarded, attemptNumber: payload.attemptNumber, correct: payload.correct },
        {},
      )
    },
  })

  await lifecycle.signal('activity-ready')
  const handle = manager.activate(appDefinition.activity, { content: { puzzle, resumeAttemptNumber } })
  return handle.implementation.attemptMove(playerMoveUci)
}
