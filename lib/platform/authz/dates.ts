// Verbatim copy of ChessMaster/lib/authz/dates.ts.
// ============================================================
// authz — calendar-day helpers
// Day boundaries are computed in a configurable IANA time zone so
// "book a slot for Tuesday" means the student's Tuesday, not UTC's.
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Format an instant as YYYY-MM-DD in the given time zone (or server-local). */
export function dateStringFor(instant: Date, timeZone?: string): string {
  // en-CA locale formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/** True if the string is a real calendar date in YYYY-MM-DD form. */
export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const roundTrip = new Date(Date.UTC(y, m - 1, d))
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === m - 1 &&
    roundTrip.getUTCDate() === d
  )
}

/** Add n calendar days to a YYYY-MM-DD string. */
export function addDays(dateString: string, n: number): string {
  const [y, m, d] = dateString.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + n))
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}
