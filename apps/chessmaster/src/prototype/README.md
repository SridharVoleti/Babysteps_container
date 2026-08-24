# Prototype logic (transcribed copy)

`constants.mjs`, `pattern-validator.mjs` and `pattern-detectors.mjs` in this directory are a
**mechanical, logic-preserving transcription** of the ChessMaster prototype's pure TypeScript
modules:

| This file | Source of truth |
|---|---|
| `constants.mjs` | `ChessMaster/lib/constants.ts` |
| `pattern-validator.mjs` | `ChessMaster/lib/PatternValidator.ts` |
| `pattern-detectors.mjs` | `ChessMaster/lib/patternDetectors.ts` |

Only type annotations, type-only imports and `as const` assertions were removed. No control
flow, values, or function signatures were changed. The ChessMaster `.ts` originals are untouched
(KEEP) and remain the files a developer edits; this directory is what the Consumer App Container
actually executes at runtime.

## Why a transcription instead of importing the `.ts` files directly

`node --test` (the only supported way to run this container, see `package.json`) executes plain
ESM `.mjs`/`.js` — it does not compile TypeScript, and the container repo intentionally ships
with **zero runtime dependencies** beyond Node itself. ChessMaster's own toolchain (`tsc`,
`ts-node`) lives in a sibling project and isn't something the container can reach into without
either (a) adding a TypeScript build step to the container's release pipeline, or (b) taking a
cross-repo filesystem dependency on ChessMaster's `node_modules`, which would violate PK-003's
deterministic-packaging requirement (a release must be traceable to its own pinned dependencies,
not a sibling repo's local checkout).

**CONTAINER CAPABILITY GAP:** the container has no supported build/bundle extension point that
would let an app package ship TypeScript source and have the container (or its release pipeline)
compile it deterministically at build time (PK-003). Today, turning a TypeScript prototype's pure
logic into something this container can import is a manual/scripted transcription step, repeated
by hand whenever the source changes. The smallest reusable container capability that would close
this gap is a documented, versioned "app build step" hook in the release composition pipeline
(PK-003) — e.g. an optional `prebuild` command declared per-app and run before packaging — so
that `tsc`/`esbuild` output becomes a normal, traceable release artifact instead of a hand-synced
copy. Affected requirements: PK-003 (release composition/traceability), CC-004 (no approved
extension point currently covers "compile app source before packaging").

Until that capability exists, keeping these files byte-for-byte parity-tested against the
ChessMaster Jest suite (see `apps/chessmaster/tests/`) is how this integration keeps the copy
honest.
