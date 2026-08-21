// Verbatim copy of ChessMaster/lib/authz/config.ts.
// ============================================================
// authz — configuration
// All quota numbers live here (or in env overrides) — never in logic.
// ============================================================

export interface AuthzConfig {
  /** Usage sessions a student may start per booked day. */
  sessionsPerDay: number
  /** Length of one usage session, in minutes. */
  sessionMinutes: number
  /** Login-token lifetime, in hours. */
  authTokenTtlHours: number
  /** How many days ahead a slot may be booked (0 = today only). */
  maxAdvanceBookingDays: number
  /** Minimum password length accepted at registration. */
  passwordMinLength: number
  /**
   * IANA time zone used to decide which calendar day "today" is
   * (e.g. 'Asia/Kolkata'). undefined = server's local time zone.
   */
  timeZone?: string
}

export const DEFAULT_AUTHZ_CONFIG: AuthzConfig = {
  sessionsPerDay: 2,
  sessionMinutes: 45,
  authTokenTtlHours: 24 * 14,
  maxAdvanceBookingDays: 30,
  passwordMinLength: 8,
}

/**
 * Build a config from environment variables, falling back to defaults.
 * Env names are prefixed so several apps can share one process env.
 */
export function authzConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  defaults: AuthzConfig = DEFAULT_AUTHZ_CONFIG,
): AuthzConfig {
  const num = (name: string, fallback: number): number => {
    const raw = env[name]
    const parsed = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  return {
    sessionsPerDay: num('AUTHZ_SESSIONS_PER_DAY', defaults.sessionsPerDay),
    sessionMinutes: num('AUTHZ_SESSION_MINUTES', defaults.sessionMinutes),
    authTokenTtlHours: num('AUTHZ_TOKEN_TTL_HOURS', defaults.authTokenTtlHours),
    maxAdvanceBookingDays: num('AUTHZ_MAX_ADVANCE_DAYS', defaults.maxAdvanceBookingDays),
    passwordMinLength: num('AUTHZ_PASSWORD_MIN_LENGTH', defaults.passwordMinLength),
    timeZone: env.AUTHZ_TIME_ZONE || defaults.timeZone,
  }
}
