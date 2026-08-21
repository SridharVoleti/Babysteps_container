// ============================================================
// authz — AuthzService (Postgres/Supabase port)
//
// Same public API and behavior as ChessMaster's lib/authz/service.ts (SQLite), ported to
// async Postgres queries via @supabase/supabase-js so it works on Vercel's serverless
// filesystem (which cannot persist a SQLite file). See ../../../supabase/migrations/0001_authz_postgres.sql
// for the schema and BabyStepsIndia-ContainerApp's integration report for why this module
// (not Supabase Auth) is the container's learner/session authority.
//
// Reusable: no Next.js imports, quota via AuthzConfig, time via an injectable Clock,
// storage via an injected SupabaseClient.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthzConfig, DEFAULT_AUTHZ_CONFIG } from './config'
import {
  AuthToken,
  AuthzError,
  Booking,
  BookingWithUsage,
  Clock,
  Student,
  systemClock,
  UsageSession,
} from './types'
import { generateToken, hashPassword, hashToken, newId, verifyPassword } from './crypto'
import { addDays, dateStringFor, isValidDateString } from './dates'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface StudentRow {
  id: string
  email: string
  display_name: string
  password_hash: string
  created_at: string
}

interface BookingRow {
  id: string
  student_id: string
  slot_date: string
  created_at: string
}

interface SessionRow {
  id: string
  student_id: string
  booking_id: string
  started_at: string
  expires_at: string
  ended_at: string | null
}

function toStudent(row: StudentRow): Student {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  }
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    studentId: row.student_id,
    slotDate: row.slot_date,
    createdAt: row.created_at,
  }
}

function toSession(row: SessionRow): UsageSession {
  return {
    id: row.id,
    studentId: row.student_id,
    bookingId: row.booking_id,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
  }
}

/** Postgres errors are opaque to callers — never leak column/table details. */
function dbError(context: string, error: { message: string }): never {
  throw new Error(`authz db error (${context}): ${error.message}`)
}

export interface StudentStatus {
  student: Student
  today: string
  todaysBooking: BookingWithUsage | null
  activeSession: (UsageSession & { secondsRemaining: number }) | null
  bookings: BookingWithUsage[]
}

export class AuthzService {
  constructor(
    private readonly db: SupabaseClient,
    private readonly config: AuthzConfig = DEFAULT_AUTHZ_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {}

  // ── authentication ────────────────────────────────────────

  async registerStudent(input: { email: string; displayName: string; password: string }): Promise<Student> {
    const email = input.email.trim().toLowerCase()
    const displayName = input.displayName.trim()
    if (!EMAIL_RE.test(email)) {
      throw new AuthzError('VALIDATION', 'Please enter a valid email address.')
    }
    if (!displayName) {
      throw new AuthzError('VALIDATION', 'Please enter a display name.')
    }
    if (input.password.length < this.config.passwordMinLength) {
      throw new AuthzError(
        'VALIDATION',
        `Password must be at least ${this.config.passwordMinLength} characters.`,
      )
    }
    const { data: existing, error: lookupError } = await this.db
      .from('students')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    if (lookupError) dbError('registerStudent lookup', lookupError)
    if (existing) {
      throw new AuthzError('EMAIL_TAKEN', 'An account with this email already exists.')
    }

    const row: StudentRow = {
      id: newId(),
      email,
      display_name: displayName,
      password_hash: hashPassword(input.password),
      created_at: this.clock.now().toISOString(),
    }
    const { error } = await this.db.from('students').insert(row)
    if (error) dbError('registerStudent insert', error)
    return toStudent(row)
  }

  async login(input: { email: string; password: string }): Promise<{ student: Student; auth: AuthToken }> {
    const email = input.email.trim().toLowerCase()
    const { data: row, error } = await this.db
      .from('students')
      .select('*')
      .eq('email', email)
      .maybeSingle<StudentRow>()
    if (error) dbError('login lookup', error)
    if (!row || !verifyPassword(input.password, row.password_hash)) {
      throw new AuthzError('INVALID_CREDENTIALS', 'Email or password is incorrect.')
    }

    const now = this.clock.now()
    const token = generateToken()
    const expiresAt = new Date(
      now.getTime() + this.config.authTokenTtlHours * 3_600_000,
    ).toISOString()
    const { error: insertError } = await this.db.from('auth_tokens').insert({
      token_hash: hashToken(token),
      student_id: row.id,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
    })
    if (insertError) dbError('login token insert', insertError)
    return { student: toStudent(row), auth: { token, expiresAt } }
  }

  async logout(token: string): Promise<void> {
    const { error } = await this.db.from('auth_tokens').delete().eq('token_hash', hashToken(token))
    if (error) dbError('logout', error)
  }

  /** Resolve a bearer token to its student; null if unknown or expired. */
  async getStudentByToken(token: string): Promise<Student | null> {
    const { data: tokenRow, error } = await this.db
      .from('auth_tokens')
      .select('student_id, expires_at')
      .eq('token_hash', hashToken(token))
      .maybeSingle<{ student_id: string; expires_at: string }>()
    if (error) dbError('getStudentByToken lookup', error)
    if (!tokenRow || tokenRow.expires_at <= this.clock.now().toISOString()) return null

    const { data: row, error: studentError } = await this.db
      .from('students')
      .select('*')
      .eq('id', tokenRow.student_id)
      .maybeSingle<StudentRow>()
    if (studentError) dbError('getStudentByToken student', studentError)
    return row ? toStudent(row) : null
  }

  // ── bookings (authorization: which day may the app be used) ──

  today(): string {
    return dateStringFor(this.clock.now(), this.config.timeZone)
  }

  async bookSlot(studentId: string, slotDate: string): Promise<Booking> {
    if (!isValidDateString(slotDate)) {
      throw new AuthzError('INVALID_DATE', 'Slot date must be a valid YYYY-MM-DD date.')
    }
    const today = this.today()
    if (slotDate < today) {
      throw new AuthzError('PAST_DATE', 'You cannot book a day that has already passed.')
    }
    const latest = addDays(today, this.config.maxAdvanceBookingDays)
    if (slotDate > latest) {
      throw new AuthzError(
        'TOO_FAR_AHEAD',
        `Slots can be booked at most ${this.config.maxAdvanceBookingDays} days ahead (up to ${latest}).`,
      )
    }
    const { data: duplicate, error: lookupError } = await this.db
      .from('bookings')
      .select('id')
      .eq('student_id', studentId)
      .eq('slot_date', slotDate)
      .maybeSingle()
    if (lookupError) dbError('bookSlot lookup', lookupError)
    if (duplicate) {
      throw new AuthzError('DUPLICATE_BOOKING', `You already have a booking on ${slotDate}.`)
    }

    const row: BookingRow = {
      id: newId(),
      student_id: studentId,
      slot_date: slotDate,
      created_at: this.clock.now().toISOString(),
    }
    const { error } = await this.db.from('bookings').insert(row)
    if (error) dbError('bookSlot insert', error)
    return toBooking(row)
  }

  async listBookings(studentId: string): Promise<BookingWithUsage[]> {
    const { data: bookingRows, error } = await this.db
      .from('bookings')
      .select('*')
      .eq('student_id', studentId)
      .order('slot_date')
      .returns<BookingRow[]>()
    if (error) dbError('listBookings', error)
    const bookings = bookingRows ?? []
    if (bookings.length === 0) return []

    const { data: usageRows, error: usageError } = await this.db
      .from('usage_sessions')
      .select('booking_id')
      .in('booking_id', bookings.map(b => b.id))
      .returns<{ booking_id: string }[]>()
    if (usageError) dbError('listBookings usage', usageError)

    const usedByBooking = new Map<string, number>()
    for (const u of usageRows ?? []) {
      usedByBooking.set(u.booking_id, (usedByBooking.get(u.booking_id) ?? 0) + 1)
    }

    return bookings.map(r => ({
      ...toBooking(r),
      sessionsUsed: usedByBooking.get(r.id) ?? 0,
      sessionsAllowed: this.config.sessionsPerDay,
    }))
  }

  async cancelBooking(studentId: string, bookingId: string): Promise<void> {
    const { data: row, error } = await this.db
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .eq('student_id', studentId)
      .maybeSingle<BookingRow>()
    if (error) dbError('cancelBooking lookup', error)
    if (!row) {
      throw new AuthzError('BOOKING_NOT_FOUND', 'Booking not found.')
    }
    const { count, error: countError } = await this.db
      .from('usage_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', bookingId)
    if (countError) dbError('cancelBooking usage count', countError)
    if ((count ?? 0) > 0) {
      throw new AuthzError(
        'BOOKING_ALREADY_USED',
        'This booking already has sessions and cannot be cancelled.',
      )
    }
    const { error: deleteError } = await this.db.from('bookings').delete().eq('id', bookingId)
    if (deleteError) dbError('cancelBooking delete', deleteError)
  }

  // ── usage sessions (the timed quota) ──────────────────────

  /**
   * Start (or resume) a usage session for today.
   * Requires a booking for today; enforces the per-day session quota.
   */
  async startSession(studentId: string): Promise<{ session: UsageSession; resumed: boolean }> {
    const active = await this.getActiveSession(studentId)
    if (active) return { session: active, resumed: true }

    const today = this.today()
    const { data: booking, error: bookingError } = await this.db
      .from('bookings')
      .select('*')
      .eq('student_id', studentId)
      .eq('slot_date', today)
      .maybeSingle<BookingRow>()
    if (bookingError) dbError('startSession booking lookup', bookingError)
    if (!booking) {
      throw new AuthzError(
        'NOT_BOOKED_TODAY',
        `You have no booking for today (${today}). Book a slot first.`,
      )
    }
    const { count, error: countError } = await this.db
      .from('usage_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', booking.id)
    if (countError) dbError('startSession usage count', countError)
    if ((count ?? 0) >= this.config.sessionsPerDay) {
      throw new AuthzError(
        'QUOTA_EXHAUSTED',
        `You have used all ${this.config.sessionsPerDay} sessions for ${today}.`,
      )
    }

    const now = this.clock.now()
    const row: SessionRow = {
      id: newId(),
      student_id: studentId,
      booking_id: booking.id,
      started_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.config.sessionMinutes * 60_000).toISOString(),
      ended_at: null,
    }
    const { error } = await this.db.from('usage_sessions').insert(row)
    if (error) dbError('startSession insert', error)
    return { session: toSession(row), resumed: false }
  }

  /** The student's currently valid session, or null. This IS the app-usage authorization check. */
  async getActiveSession(studentId: string): Promise<UsageSession | null> {
    const { data: rows, error } = await this.db
      .from('usage_sessions')
      .select('*')
      .eq('student_id', studentId)
      .is('ended_at', null)
      .gt('expires_at', this.clock.now().toISOString())
      .order('started_at', { ascending: false })
      .limit(1)
      .returns<SessionRow[]>()
    if (error) dbError('getActiveSession', error)
    const row = rows?.[0]
    return row ? toSession(row) : null
  }

  /** End the active session early. The session still counts against the quota. */
  async endSession(studentId: string): Promise<UsageSession> {
    const active = await this.getActiveSession(studentId)
    if (!active) {
      throw new AuthzError('NO_ACTIVE_SESSION', 'There is no active session to end.')
    }
    const endedAt = this.clock.now().toISOString()
    const { error } = await this.db.from('usage_sessions').update({ ended_at: endedAt }).eq('id', active.id)
    if (error) dbError('endSession', error)
    return { ...active, endedAt }
  }

  /** Everything the account screen needs in one call. */
  async getStatus(student: Student): Promise<StudentStatus> {
    const today = this.today()
    const bookings = await this.listBookings(student.id)
    const todaysBooking = bookings.find(b => b.slotDate === today) ?? null
    const active = await this.getActiveSession(student.id)
    return {
      student,
      today,
      todaysBooking,
      bookings,
      activeSession: active
        ? {
            ...active,
            secondsRemaining: Math.max(
              0,
              Math.floor(
                (new Date(active.expiresAt).getTime() - this.clock.now().getTime()) / 1000,
              ),
            ),
          }
        : null,
    }
  }
}
