'use client'

import { useCallback, useEffect, useState } from 'react'

// Mirrors the JSON returned by /api/v1/auth/me (lib/platform/authz StudentStatus).
interface Booking {
  id: string
  slotDate: string
  sessionsUsed: number
  sessionsAllowed: number
}
interface ActiveSession {
  id: string
  expiresAt: string
  secondsRemaining: number
}
interface Status {
  student: { id: string; email: string; displayName: string }
  today: string
  todaysBooking: Booking | null
  activeSession: ActiveSession | null
  bookings: Booking[]
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`)
  return body as T
}

function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function AccountClient() {
  const [status, setStatus] = useState<Status | null>(null)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [countdown, setCountdown] = useState(0)

  // auth form state
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [slotDate, setSlotDate] = useState('')

  const refresh = useCallback(async () => {
    try {
      const s = await api<Status>('/api/v1/auth/me')
      setStatus(s)
      setCountdown(s.activeSession?.secondsRemaining ?? 0)
    } catch {
      setStatus(null)
    } finally {
      setChecked(true)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Tick the session countdown once per second while a session is active.
  useEffect(() => {
    if (!status?.activeSession) return
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          refresh()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [status?.activeSession, refresh])

  const run = async (fn: () => Promise<void>) => {
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    }
  }

  const submitAuth = () =>
    run(async () => {
      if (mode === 'register') {
        await api('/api/v1/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, displayName, password }),
        })
      } else {
        await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
      }
      setPassword('')
      await refresh()
    })

  const logout = () =>
    run(async () => {
      await api('/api/v1/auth/logout', { method: 'POST' })
      await refresh()
    })

  const book = () =>
    run(async () => {
      await api('/api/v1/bookings', { method: 'POST', body: JSON.stringify({ slotDate }) })
      setNotice(`Booked ${slotDate}.`)
      setSlotDate('')
      await refresh()
    })

  const cancelBooking = (id: string) =>
    run(async () => {
      await api(`/api/v1/bookings/${id}`, { method: 'DELETE' })
      await refresh()
    })

  const startSession = () =>
    run(async () => {
      await api('/api/v1/sessions', { method: 'POST' })
      setNotice('Session started — enjoy your practice!')
      await refresh()
    })

  const endSession = () =>
    run(async () => {
      await api('/api/v1/sessions', { method: 'DELETE' })
      setNotice('Session ended.')
      await refresh()
    })

  if (!checked) {
    return <main className="mx-auto max-w-xl p-8 text-gray-500">Loading…</main>
  }

  // ── logged out: login / register ──────────────────────────
  if (!status) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="mb-6 text-2xl font-bold">
          {mode === 'login' ? 'Log in to ChessQuest' : 'Create your ChessQuest account'}
        </h1>
        {error && <p className="mb-4 rounded bg-red-100 p-3 text-red-800">{error}</p>}
        <form
          className="space-y-4"
          onSubmit={e => {
            e.preventDefault()
            submitAuth()
          }}
        >
          <input
            className="w-full rounded border p-2"
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          {mode === 'register' && (
            <input
              className="w-full rounded border p-2"
              placeholder="Display name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              required
            />
          )}
          <input
            className="w-full rounded border p-2"
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          <button className="w-full rounded bg-indigo-600 p-2 font-semibold text-white" type="submit">
            {mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>
        <button
          className="mt-4 text-sm text-indigo-600 underline"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'New here? Create an account' : 'Already registered? Log in'}
        </button>
      </main>
    )
  }

  // ── logged in: bookings + session control ─────────────────
  const { student, today, todaysBooking, bookings } = status
  const sessionsLeft = todaysBooking
    ? todaysBooking.sessionsAllowed - todaysBooking.sessionsUsed
    : 0

  return (
    <main className="mx-auto max-w-xl space-y-8 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hi, {student.displayName}!</h1>
          <p className="text-sm text-gray-500">{student.email} · today is {today}</p>
        </div>
        <button className="rounded border px-3 py-1 text-sm" onClick={logout} data-testid="logout">
          Log out
        </button>
      </header>

      {error && <p className="rounded bg-red-100 p-3 text-red-800">{error}</p>}
      {notice && <p className="rounded bg-green-100 p-3 text-green-800">{notice}</p>}

      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-lg font-semibold">Today&apos;s practice</h2>
        {status.activeSession ? (
          <div className="space-y-3">
            <p className="text-3xl font-mono font-bold text-green-700" data-testid="countdown">
              {formatCountdown(countdown)}
            </p>
            <p className="text-sm text-gray-600">left in your current session.</p>
            <div className="flex gap-3">
              <a className="rounded bg-indigo-600 px-4 py-2 font-semibold text-white" href="/apps/chessmaster/fork">
                Go play →
              </a>
              <button className="rounded border px-4 py-2" onClick={endSession}>
                End session
              </button>
            </div>
          </div>
        ) : todaysBooking ? (
          <div className="space-y-3">
            <p>
              You have <strong>{sessionsLeft}</strong> of {todaysBooking.sessionsAllowed} sessions
              left today.
            </p>
            {sessionsLeft > 0 ? (
              <button
                className="rounded bg-green-600 px-4 py-2 font-semibold text-white"
                onClick={startSession}
                data-testid="start-session"
              >
                Start session
              </button>
            ) : (
              <p className="text-gray-600">All sessions used — see you next booked day!</p>
            )}
          </div>
        ) : (
          <p className="text-gray-600">No booking for today. Book a day below to practise.</p>
        )}
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-lg font-semibold">Book a practice day</h2>
        <form
          className="flex gap-3"
          onSubmit={e => {
            e.preventDefault()
            book()
          }}
        >
          <input
            className="rounded border p-2"
            type="date"
            value={slotDate}
            onChange={e => setSlotDate(e.target.value)}
            required
            data-testid="slot-date"
          />
          <button className="rounded bg-indigo-600 px-4 py-2 font-semibold text-white" type="submit">
            Book
          </button>
        </form>

        {bookings.length > 0 && (
          <ul className="mt-4 divide-y" data-testid="bookings">
            {bookings.map(b => (
              <li key={b.id} className="flex items-center justify-between py-2">
                <span>
                  {b.slotDate}
                  {b.slotDate === today && ' (today)'}
                  <span className="ml-2 text-sm text-gray-500">
                    {b.sessionsUsed}/{b.sessionsAllowed} sessions used
                  </span>
                </span>
                {b.sessionsUsed === 0 && (
                  <button
                    className="text-sm text-red-600 underline"
                    onClick={() => cancelBooking(b.id)}
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
