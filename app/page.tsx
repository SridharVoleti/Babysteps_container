import type { Metadata } from 'next'
import type { CSSProperties } from 'react'
import { Reveal } from '@/components/Reveal'

export const metadata: Metadata = {
  title: 'ChessQuest — Raise a sharp thinker in the age of AI',
  description:
    'Chess tactics training for kids. Build decision making, pattern recognition and deep focus through guided games — 45-minute sessions on days you book.',
}

// ── content (data-driven so copy can be tuned without touching layout) ──

const AI_ERA_PILLARS = [
  {
    icon: 'scale' as const,
    title: 'Decision making is the new literacy',
    body: 'AI can hand your child a thousand answers — it cannot choose for them. Every chess move is a real decision with real consequences, made under pressure and owned completely. That muscle transfers to homework, friendships and, one day, careers.',
  },
  {
    icon: 'eye' as const,
    title: 'Pattern recognition is the key skill',
    body: 'Grandmasters do not calculate everything — they recognise patterns instantly. That is exactly how great scientists, doctors and engineers think. ChessQuest teaches 12 named tactical patterns, one at a time, until your child sees them everywhere.',
  },
  {
    icon: 'zap' as const,
    title: 'Staying sharp beats scrolling numb',
    body: 'Feeds train kids to skim for 8 seconds. Chess trains them to hold deep, effortful focus for a whole game. In a distraction economy, a child who can concentrate is a child with an unfair advantage.',
  },
]

const LIFE_BENEFITS = [
  {
    icon: 'map' as const,
    title: 'Thinking ahead',
    body: 'If I do this, they do that. Chess makes cause and effect visible — the foundation of planning and self-control.',
  },
  {
    icon: 'shield' as const,
    title: 'Resilience',
    body: 'Every lost game is feedback, not failure. Kids learn to analyse mistakes calmly and come back stronger.',
  },
  {
    icon: 'calculator' as const,
    title: 'Math & memory gains',
    body: 'Studies link chess practice to stronger arithmetic, geometry intuition and working memory.',
  },
  {
    icon: 'heart' as const,
    title: 'Patience & sportsmanship',
    body: 'Waiting your turn, shaking hands, respecting the opponent — chess quietly teaches manners that stick.',
  },
  {
    icon: 'trophy' as const,
    title: 'Earned confidence',
    body: 'Progress in chess cannot be faked. Each mastered pattern is proof to your child that effort works.',
  },
  {
    icon: 'clock' as const,
    title: 'Healthy screen time by design',
    body: 'Sessions are 45 focused minutes, at most two on the day you book. It ends before it turns into bingeing — by design, not willpower.',
  },
]

const HOW_IT_WORKS = [
  {
    step: '1',
    title: 'Book a practice day',
    body: 'Pick the day that suits your family. On that day your child gets two 45-minute sessions — structure parents control.',
  },
  {
    step: '2',
    title: 'Learn one pattern at a time',
    body: 'A short animated lesson introduces a tactic — the Fork, the Pin, the Skewer — in language a child actually enjoys.',
  },
  {
    step: '3',
    title: 'Spot it in real games',
    body: 'Our coach-CPU plays real openings and quietly walks into the pattern. Your child must see it and strike — that moment of "I found it!" is where learning locks in.',
  },
  {
    step: '4',
    title: 'Level up the roadmap',
    body: 'Twelve patterns, XP, streaks and a candy-trail map from Fork to Zwischenzug. Kids beg to continue — you decide the days.',
  },
]

// Decorative chess pieces floating in the hero (position/size/timing per piece)
const FLOATING_PIECES = [
  { icon: 'knight', pos: 'left-[4%] top-[8%]',      size: 'h-16 w-16', color: 'text-blue-500/20',   dur: '7s',   delay: '0s' },
  { icon: 'pawn',   pos: 'right-[7%] top-[14%]',    size: 'h-11 w-11', color: 'text-orange-500/25', dur: '5.5s', delay: '0.8s' },
  { icon: 'rook',   pos: 'left-[10%] bottom-[10%]', size: 'h-12 w-12', color: 'text-orange-400/20', dur: '8s',   delay: '0.4s' },
  { icon: 'queen',  pos: 'right-[12%] bottom-[16%]', size: 'h-16 w-16', color: 'text-blue-400/20',  dur: '6.5s', delay: '1.2s' },
  { icon: 'bishop', pos: 'left-[44%] top-[3%]',     size: 'h-10 w-10', color: 'text-slate-400/25',  dur: '9s',   delay: '0.2s' },
] as const

// ── inline SVG icons (Lucide-style, consistent 2px stroke) ──

function Icon({ name, className }: { name: string; className?: string }) {
  const paths: Record<string, JSX.Element> = {
    scale: (
      <>
        <path d="M12 3v18M3 21h18" />
        <path d="M7 7l-4 7a4 4 0 0 0 8 0L7 7zM17 7l-4 7a4 4 0 0 0 8 0l-4-7z" />
        <path d="M4 7h16" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    zap: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />,
    map: (
      <>
        <path d="M9 3 4 5v16l5-2 6 2 5-2V3l-5 2-6-2z" />
        <path d="M9 3v16M15 5v16" />
      </>
    ),
    shield: (
      <>
        <path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    calculator: (
      <>
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <path d="M8 6h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" />
      </>
    ),
    heart: <path d="M12 21C7 16.5 3 13 3 8.8 3 6 5.2 4 7.8 4c1.7 0 3.2.8 4.2 2.2C13 4.8 14.5 4 16.2 4 18.8 4 21 6 21 8.8c0 4.2-4 7.7-9 12.2z" />,
    trophy: (
      <>
        <path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 0 1-10 0V4z" />
        <path d="M7 6H4a2 2 0 0 0 2 5h1M17 6h3a2 2 0 0 1-2 5h-1" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    knight: (
      <path d="M6 21h12M7 18h10M9 18c0-3-2-4-2-7a7 7 0 0 1 7-7l-1 3 3 1c1.5.8 2 2.5 1.5 4L16 18" />
    ),
    pawn: (
      <>
        <circle cx="12" cy="6" r="2.5" />
        <path d="M12 8.5c-1.5 3-2 5.5-2 8.5h4c0-3-.5-5.5-2-8.5zM7 21h10" />
      </>
    ),
    rook: (
      <>
        <path d="M6 21h12M8 18h8M9 18l.5-8h5l.5 8" />
        <path d="M7 4h2v2h2V4h2v2h2V4h2v4H7V4z" />
      </>
    ),
    queen: (
      <>
        <path d="M5 20h14M6 17l-1.5-9L9 11l3-6 3 6 4.5-3L18 17H6z" />
      </>
    ),
    bishop: (
      <>
        <path d="M8 21h8M12 3l3 5c1.5 2.5.5 6-3 6s-4.5-3.5-3-6l3-5zM12 14v4" />
      </>
    ),
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths[name]}
    </svg>
  )
}

function EnrollButton({ label = 'Enroll now — book a session' }: { label?: string }) {
  return (
    <a
      href="/account"
      className="clay clay-press cta-pulse inline-block cursor-pointer bg-orange-600 px-8 py-4 text-lg font-bold text-white focus:outline-none focus-visible:ring-4 focus-visible:ring-orange-300"
    >
      {label}
    </a>
  )
}

// ── page ──

export default function Home() {
  return (
    <div className="font-body min-h-screen bg-slate-50 text-slate-800">
      {/* Google Fonts with graceful system fallback (see globals.css) */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Comic+Neue:wght@400;700&display=swap"
        rel="stylesheet"
      />

      {/* nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <a href="/" className="font-display flex items-center gap-2 text-2xl font-bold text-blue-600">
          <span className="clay flex h-10 w-10 items-center justify-center bg-blue-600 text-white">
            <Icon name="knight" className="h-6 w-6" />
          </span>
          ChessQuest
        </a>
        <nav className="flex items-center gap-4">
          <a
            href="/account"
            className="hidden cursor-pointer font-semibold text-slate-600 hover:text-blue-600 sm:inline"
          >
            Log in
          </a>
          <a
            href="/account"
            className="clay clay-press cursor-pointer bg-orange-600 px-5 py-2 font-bold text-white"
          >
            Enroll now
          </a>
        </nav>
      </header>

      {/* hero */}
      <section className="relative mx-auto max-w-6xl px-6 pb-20 pt-12 text-center md:pt-20">
        {/* floating decorative pieces */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          {FLOATING_PIECES.map(piece => (
            <span
              key={`${piece.icon}-${piece.pos}`}
              className={`float-piece ${piece.pos} ${piece.color}`}
              style={{ '--float-dur': piece.dur, '--float-delay': piece.delay } as CSSProperties}
            >
              <Icon name={piece.icon} className={piece.size} />
            </span>
          ))}
        </div>

        <div className="relative">
          <p
            className="hero-enter font-display mx-auto mb-4 inline-block rounded-full bg-blue-100 px-4 py-1 font-semibold text-blue-700"
          >
            Chess tactics training for ages 5 and above
          </p>
          <h1
            className="hero-enter font-display mx-auto max-w-4xl text-4xl font-extrabold leading-tight text-slate-900 md:text-6xl"
            style={{ animationDelay: '90ms' }}
          >
            AI will do the remembering.
            <br />
            <span className="text-blue-600">Your child must do the thinking.</span>
          </h1>
          <p
            className="hero-enter mx-auto mt-6 max-w-2xl text-lg text-slate-600 md:text-xl"
            style={{ animationDelay: '180ms' }}
          >
            Calculators didn&apos;t end math — and AI won&apos;t end thinking. But it raises the bar:
            the kids who thrive will be the ones who <strong>decide well</strong>,{' '}
            <strong>spot patterns fast</strong> and <strong>stay sharp</strong>. For 1,500 years,
            nothing has trained those three like chess.
          </p>
          <div
            className="hero-enter mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
            style={{ animationDelay: '270ms' }}
          >
            <EnrollButton />
            <a
              href="#why-now"
              className="clay clay-press cursor-pointer bg-white px-8 py-4 text-lg font-bold text-blue-700"
            >
              Why chess, why now?
            </a>
          </div>
          <p className="hero-enter mt-6 text-sm text-slate-500" style={{ animationDelay: '360ms' }}>
            Two 45-minute sessions on the day you book · no endless screen time · first pattern free
          </p>
        </div>
      </section>

      {/* AI-era pillars */}
      <section id="why-now" className="bg-blue-600 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <Reveal>
            <h2 className="font-display text-center text-3xl font-extrabold text-white md:text-4xl">
              In the AI era, three skills separate the sharp from the passive
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-blue-100">
              Machines produce answers. Children still have to judge them. Chess is the oldest,
              most joyful gym for exactly that judgement.
            </p>
          </Reveal>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {AI_ERA_PILLARS.map((pillar, i) => (
              <Reveal
                key={pillar.title}
                as="article"
                delayMs={i * 90}
                className="clay card-hover group bg-white p-8"
              >
                <span className="clay icon-bubble flex h-14 w-14 items-center justify-center bg-orange-100 text-orange-600">
                  <Icon name={pillar.icon} className="h-7 w-7" />
                </span>
                <h3 className="font-display mt-5 text-xl font-bold text-slate-900">{pillar.title}</h3>
                <p className="mt-3 leading-relaxed text-slate-600">{pillar.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* broader benefits */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <Reveal>
          <h2 className="font-display text-center text-3xl font-extrabold text-slate-900 md:text-4xl">
            More than a game — a character workout
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-slate-600">
            The board is 64 squares. What it builds shows up everywhere else.
          </p>
        </Reveal>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {LIFE_BENEFITS.map((benefit, i) => (
            <Reveal
              key={benefit.title}
              as="article"
              delayMs={i * 70}
              className="clay card-hover group bg-white p-6"
            >
              <div className="flex items-center gap-3">
                <span className="clay icon-bubble flex h-11 w-11 shrink-0 items-center justify-center bg-blue-100 text-blue-600">
                  <Icon name={benefit.icon} className="h-6 w-6" />
                </span>
                <h3 className="font-display text-lg font-bold text-slate-900">{benefit.title}</h3>
              </div>
              <p className="mt-3 leading-relaxed text-slate-600">{benefit.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* how it works */}
      <section className="bg-orange-50 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <Reveal>
            <h2 className="font-display text-center text-3xl font-extrabold text-slate-900 md:text-4xl">
              How ChessQuest works
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-slate-600">
              Not videos to watch — traps to spring. Your child learns each tactic by catching a
              CPU that walks right into it.
            </p>
          </Reveal>
          <ol className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {HOW_IT_WORKS.map((item, i) => (
              <Reveal
                key={item.step}
                as="li"
                delayMs={i * 90}
                className="clay card-hover group bg-white p-6"
              >
                <span className="font-display clay icon-bubble flex h-11 w-11 items-center justify-center bg-blue-600 text-xl font-extrabold text-white">
                  {item.step}
                </span>
                <h3 className="font-display mt-4 text-lg font-bold text-slate-900">{item.title}</h3>
                <p className="mt-2 leading-relaxed text-slate-600">{item.body}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* final CTA */}
      <section className="mx-auto max-w-4xl px-6 py-20 text-center">
        <Reveal className="clay bg-white p-10 md:p-14">
          <h2 className="font-display text-3xl font-extrabold text-slate-900 md:text-4xl">
            The best time to teach a child to think was yesterday.
          </h2>
          <p className="font-display mt-2 text-2xl font-bold text-blue-600 md:text-3xl">
            The second-best time is their next free afternoon.
          </p>
          <p className="mx-auto mt-5 max-w-xl text-slate-600">
            Create an account, book the day that suits you, and your child&apos;s first pattern —
            the mighty Fork — is waiting. Two focused 45-minute sessions. Zero nagging required.
          </p>
          <div className="mt-8">
            <EnrollButton label="Enroll now — it takes 2 minutes" />
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-sm text-slate-500">
        <p>ChessQuest — pattern-by-pattern chess tactics for kids. Built for sharp minds.</p>
      </footer>
    </div>
  )
}
