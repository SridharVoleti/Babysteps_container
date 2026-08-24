// Verbatim copy of ChessMaster/lib/authz/types.ts — pure TypeScript, no framework or
// database imports. This module is used only by lib/platform/** (the Babysteps Platform
// API routes under app/api/v1/**); nothing outside lib/platform imports it.
// ============================================================
// authz — shared types
// ============================================================

/** Injectable time source so all quota/expiry logic is testable. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

export interface Student {
  id: string
  email: string
  displayName: string
  createdAt: string // ISO 8601 UTC
}

export interface Booking {
  id: string
  studentId: string
  /** Calendar day the student reserved, as YYYY-MM-DD in the configured time zone. */
  slotDate: string
  createdAt: string
}

export interface BookingWithUsage extends Booking {
  sessionsUsed: number
  sessionsAllowed: number
}

export interface UsageSession {
  id: string
  studentId: string
  bookingId: string
  startedAt: string // ISO 8601 UTC
  expiresAt: string // ISO 8601 UTC
  endedAt: string | null
}

export interface AuthToken {
  token: string // raw token — returned once at login, only its hash is stored
  expiresAt: string
}

export type AuthzErrorCode =
  | 'VALIDATION'
  | 'EMAIL_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'NOT_AUTHENTICATED'
  | 'INVALID_DATE'
  | 'PAST_DATE'
  | 'TOO_FAR_AHEAD'
  | 'DUPLICATE_BOOKING'
  | 'BOOKING_NOT_FOUND'
  | 'BOOKING_ALREADY_USED'
  | 'NOT_BOOKED_TODAY'
  | 'QUOTA_EXHAUSTED'
  | 'NO_ACTIVE_SESSION'

export class AuthzError extends Error {
  constructor(
    public readonly code: AuthzErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuthzError'
  }
}
