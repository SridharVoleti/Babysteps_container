import { notFound, redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getAuthzService, studentFromCookies } from '@/lib/platform/authz/nextAdapter'
import { ChessmasterGame, type Puzzle } from './ChessmasterGame'
import forkPuzzleContent from '@/apps/chessmaster/content/pattern-fork-01.json'

// Only 'fork' is wired end-to-end in this vertical slice (matches apps/chessmaster's current
// scope — see apps/chessmaster/src/prototype/README.md and the integration report for the
// other 11 patterns' status).
const PUZZLES: Record<string, Puzzle> = {
  fork: forkPuzzleContent.puzzle as Puzzle,
}

interface Props {
  params: { pattern: string }
}

// Every render depends on the requester's session cookie (auth + active booked-day usage),
// so this route must never be statically generated or ISR-cached — a cached render for one
// student's cookies must not be served to another request. generateStaticParams (build-time
// prerendering) is incompatible with that and was causing Vercel to cache a stale notFound()
// render for /fork behind the deployment's edge cache.
export const dynamic = 'force-dynamic'

export default async function PlayPage({ params }: Props) {
  // SB-001: playing requires a logged-in student with an active booked-day usage session —
  // this is the container's launch authority, not an optional gate (see lib/platform/authz).
  const student = await studentFromCookies(cookies())
  if (!student) redirect('/account')
  if (!(await getAuthzService().getActiveSession(student.id))) redirect('/account')

  const puzzle = PUZZLES[params.pattern]
  if (!puzzle) notFound()

  return <ChessmasterGame puzzle={puzzle} />
}
