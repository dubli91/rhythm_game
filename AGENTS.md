# AGENTS.md

## Build & Run

TypeScript + Vite + PixiJS + Web Audio, browser-only, no server. The specs in `specs/*`
are authoritative on the stack (do NOT use Python/UV — the `.venv` etc. were residue of a
scrapped prototype and are gitignored).

- Dev server: `npm run dev`
- Production build: `npm run build` (runs `tsc --noEmit` first, then `vite build`)
- Preview build: `npm run preview`

## Validation

Run these after implementing to get immediate feedback:

- Tests: `npm run test` (Vitest, headless node env; watch mode: `npm run test:watch`)
- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict + verbatimModuleSyntax + noUncheckedIndexedAccess)
- Lint/format check: `npm run lint` (Biome); auto-format: `npm run format`

## Operational Notes

- Node 22 / npm 10 available. No network needed after `npm install`.
- Unit tests run in a plain node environment (no DOM): storage tests inject fakes
  (`fake-indexeddb`, in-memory Storage); Web Audio wrappers take injectable stubs.
- `src/lib/` is the shared standard library (chart types/timing/validation, clock, storage,
  events, rng, audio helpers). Implement cross-cutting utilities there ONCE — feature code
  must not re-implement them.
- Directory layout: `src/lib/` (stdlib), `src/app/` (shell + entry `src/app/main.ts`),
  `src/features/` (feature modules), `public/songs/` (built-in song assets).

### Codebase Patterns

- `verbatimModuleSyntax` is on: type-only imports must use `import type`.
- All localStorage access goes through `src/lib/storage/local.ts` (versioned single-doc keys:
  `settings.v1`, `playOptions.v1`, `records.v1`). All IndexedDB access goes through
  `src/lib/storage/idb.ts` (db `iidx-web`, stores `songs`/`audio`/`practicePatterns`).
- `AudioContext.currentTime` is the only game clock; never use rAF timestamps for song time.
