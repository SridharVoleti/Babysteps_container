// The one service-role Supabase client factory in this repo. Used only by lib/platform/**
// (the Babysteps Platform API routes under app/api/v1/**) — CC-003 forbids apps/chessmaster
// and lib/host/** from ever importing this.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  if (!url || !serviceKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY are required to reach the Babysteps Platform API database.',
    )
  }

  cached = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    // Next.js 14's fetch() patch caches GET requests (force-cache) by default, keyed by URL —
    // including third-party libraries' calls, since they resolve the same patched global
    // fetch. Every read here is authoritative platform state (bookings, sessions, progress),
    // so every request must bypass that cache; route-level `dynamic = 'force-dynamic'` alone
    // does not guarantee that for fetches made outside the route handler's own code.
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
  })
  return cached
}
