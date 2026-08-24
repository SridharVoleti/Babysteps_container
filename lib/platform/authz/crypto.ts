// Verbatim copy of ChessMaster/lib/authz/crypto.ts.
// ============================================================
// authz — password hashing + token helpers
// Node crypto only; no external dependencies.
// ============================================================

import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'crypto'

// scrypt cost parameters — encoded into every hash so they can be
// raised later without invalidating existing hashes.
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Raw bearer token handed to the client (returned once, never stored). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Only this digest is persisted, so a leaked DB does not leak live tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newId(): string {
  return randomUUID()
}
