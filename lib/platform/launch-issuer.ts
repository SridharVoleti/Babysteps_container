// SB-001 launch-context issuance. Mirrors the ECDSA P-256 verification in
// ../../src/container/internal/bootstrap/babysteps-launch-verifier.mjs's
// createBabystepsLaunchVerifier() exactly (same claim canonicalization, same algorithm, same
// raw r||s signature encoding), so a context issued here verifies successfully there. Only
// the verifier is exported by the container (issuance is a platform-side concern by design —
// the container never signs on an app's behalf), so this small, precisely-mirrored issuer
// lives on the platform side instead, holding the private key the container never sees.
import { randomUUID } from 'crypto'

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
  kid: string
}

const IMPORT_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const

let cachedSigningKey: { kid: string; key: CryptoKey } | null = null

async function signingKey(): Promise<{ kid: string; key: CryptoKey }> {
  if (cachedSigningKey) return cachedSigningKey

  const kid = process.env.BABYSTEPS_LAUNCH_KEY_ID
  const jwkJson = process.env.BABYSTEPS_LAUNCH_PRIVATE_KEY
  if (!kid || !jwkJson) {
    throw new Error(
      'BABYSTEPS_LAUNCH_KEY_ID and BABYSTEPS_LAUNCH_PRIVATE_KEY must be configured to issue a launch context.',
    )
  }

  let jwk: JsonWebKey
  try {
    jwk = JSON.parse(jwkJson)
  } catch {
    throw new Error('BABYSTEPS_LAUNCH_PRIVATE_KEY must be a valid P-256 EC private key JWK.')
  }

  const key = await crypto.subtle.importKey('jwk', jwk, IMPORT_ALGORITHM, false, ['sign'])
  cachedSigningKey = { kid, key }
  return cachedSigningKey
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export async function issueLaunchContext(claims: LaunchClaims): Promise<LaunchEnvelope> {
  const { kid, key } = await signingKey()
  const data = new TextEncoder().encode(canonicalizeClaims(claims as unknown as Record<string, string>))
  const signature = await crypto.subtle.sign(SIGN_ALGORITHM, key, data)
  return { claims, proof: bytesToHex(new Uint8Array(signature)), kid }
}

export function newCorrelationId(): string {
  return randomUUID()
}
