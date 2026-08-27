# BabySteps → ChessMaster launch integration

Implements the browser handoff specified in `../../CHESSMASTER_LAUNCH_INTEGRATION.md`: a
BabySteps parent taps "Open ChessMaster" and lands in the game with the child already signed
in, without the child's identity ever passing through the browser.

## Routes

| Route | Method | Handler | Status |
|---|---|---|---|
| `/launch` | `POST` | `app/launch/route.ts` | Full — receives the handoff, exchanges the code, verifies the bootstrap assertion, starts the session, redirects into the game |
| `/health` | `GET` | `app/health/route.ts` | Full — `200 ok`; `?deep=1` also round-trips the session store; `503` on dependency failure |
| `/return` | `GET` | `app/return/route.ts` | Minimal — ends the local session, clears the cookie, redirects to BabySteps |
| `/identity` | `GET` | `app/identity/route.ts` | `501` — reserved, no live BabySteps caller yet |

## Flow (`POST /launch`)

```
form { launchCode, launchAttemptId }
  → exchangeLaunchCode()      mint EdDSA app assertion → POST BabySteps exchange endpoint
  → verifyBootstrapAssertion() HS256 verify with the shared secret; check iss / aud / app_id
  → provisionLaunchSession()   upsert students row + booking(today) + usage_sessions row
  → 303 redirect to /apps/chessmaster/fork  + Set-Cookie: babysteps_auth
```

Every failure fails closed: the browser gets a plain error page with a safe message; details
go only to the server log.

## Code

- `lib/platform/app-launch/` — all `.mjs` (mirrors the `.mjs` + `node:test` pattern of
  `src/container/internal/bootstrap/babysteps-launch-verifier.mjs`). Lives under
  `lib/platform/` because it is the only layer allowed to hold the secrets and make the
  outbound call (CC-003).
  - `config.mjs` — reads/validates `APP_LAUNCH_*`; fails closed on any missing value
  - `app-assertion.mjs` — mints the 60-second EdDSA `x-babysteps-app-assertion` token
  - `exchange.mjs` — the server-to-server call to BabySteps
  - `bootstrap-assertion.mjs` — HS256 verification → typed `LearnerBootstrap`
  - `provision-launch-session.mjs` — bridge to `lib/platform/authz`
  - `handle-app-launch.mjs` — orchestrator (framework-agnostic, never throws)
- `lib/platform/authz/service.ts` — added `issueToken`, `upsertLaunchStudent`,
  `ensureBookingForToday`, `startLaunchSession` (all additive; existing methods unchanged).
  A launched learner becomes a normal row in the same learner/session authority the SB-001
  launch issuer (`app/api/v1/sessions/route.ts`) already reads, so the play gate at
  `app/apps/chessmaster/[pattern]/page.tsx` is satisfied with no change to the gate.

## Relationship to the existing SB-001 launch

Complementary, no overlap. `/launch` establishes the `babysteps_auth` cookie + a
`usage_sessions` row. The existing per-move route
(`app/api/runtime/chessmaster/attempt-move/route.ts`) then issues ECDSA-P256 SB-001
envelopes off that same session exactly as it does today.

## Configuration

Set the `APP_LAUNCH_*` block from `.env.example`. All values are provisioned by BabySteps at
onboarding and delivered through a secure channel — never commit real values.

| Var | Notes |
|---|---|
| `APP_LAUNCH_CLIENT_ID` | our `client_id` |
| `APP_LAUNCH_SIGNING_PRIVATE_KEY` | Ed25519 **private** JWK (JSON). BabySteps registers the public half. |
| `APP_LAUNCH_BOOTSTRAP_SECRET` | 32+ char HS256 shared secret |
| `APP_LAUNCH_APP_ID` / `_ENVIRONMENT` / `_DEPLOYMENT_ID` | bind tokens to a release |
| `APP_LAUNCH_EXCHANGE_URL` | optional; defaults to the production endpoint |
| `APP_LAUNCH_BOOTSTRAP_ISSUER` | optional; defaults to `https://babysteps.in` |
| `APP_LAUNCH_RETURN_URL` | optional; where `/return` sends the learner |
| `APP_LAUNCH_LANDING_PATH` | optional; defaults to `/apps/chessmaster/fork` |

### Credentials checklist (from the spec)

- [ ] Ed25519 keypair + `client_id` — public half registered with BabySteps
- [ ] `APP_LAUNCH_BOOTSTRAP_SECRET`
- [ ] `app_id`, `environment`, `deployment_id`
- [ ] Exchange endpoint URL (production; staging TBD once BabySteps binds a staging env)

## Tests

`npm run test:launch` (also part of `npm test`). Covers assertion mint/verify, bootstrap
verification (bad secret / iss / aud / expiry / app_id all rejected), exchange failure
modes, and the full orchestrator (fail-closed, provisioning, resume-not-stack).

## Local end-to-end

`scripts/simulate-app-launch.mjs` stands up a fake exchange endpoint and posts a launch form
to a running dev server, so the flow can be exercised without the real BabySteps endpoint.
See the script header for usage.

## Known gaps

- **`app-sdk.ts` not provided.** The spec points at a reusable BabySteps module
  (`handleAppLaunchPost` + `establishAppLocalSession`); it is in neither repo, so
  `lib/platform/app-launch/` is a from-scratch equivalent. Reconcile if BabySteps ships the
  canonical module later.
- **Exchange endpoint is production-only** — no staging URL yet. Automated tests inject a
  fake `fetch`; local testing uses the simulator.
- **`/return` and `/identity`** are intentionally minimal — no live BabySteps caller yet.
- **Quota bypass** for launched sessions is deliberate (`startLaunchSession` skips the
  per-day `QUOTA_EXHAUSTED` check) — BabySteps owns entitlement. A booking + usage_session
  row is still written for auditability.
