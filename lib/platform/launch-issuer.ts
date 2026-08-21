// SB-001 launch-context issuance. Mirrors the HMAC canonicalization in
// ../../src/container/internal/bootstrap/babysteps-launch-verifier.mjs's
// createBabystepsLaunchVerifier() exactly, so a context issued here verifies successfully
// there. Only the verifier is exported by the container (issuance is a platform-side
// concern by design — the container never signs on an app's behalf), so this small,
// precisely-mirrored issuer lives on the platform side instead.
import { createHmac, randomUUID } from 'crypto'

function canonicalizeClaims(claims: Record<string, string>): string {
  return JSON.stringify(claims, Object.keys(claims).sort())
}

export interface LaunchClaims {
  learnerId: string
  appId: string
  releaseId: string
  sessionId: string
  launchMode: 'start' | 'resume'
  issuedAt: string
  expiresAt: string
  correlationId: string
}

export interface LaunchEnvelope {
  claims: LaunchClaims
  proof: string
}

export function issueLaunchContext(claims: LaunchClaims): LaunchEnvelope {
  const verificationKey = process.env.BABYSTEPS_LAUNCH_VERIFICATION_KEY
  if (!verificationKey || verificationKey.length < 32) {
    throw new Error(
      'BABYSTEPS_LAUNCH_VERIFICATION_KEY must be configured (>=32 chars) to issue a launch context.',
    )
  }
  const proof = createHmac('sha256', verificationKey)
    .update(canonicalizeClaims(claims as unknown as Record<string, string>))
    .digest('hex')
  return { claims, proof }
}

export function newCorrelationId(): string {
  return randomUUID()
}
