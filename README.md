# PRISMBEAT

A browser-only 7-key + turntable rhythm game. Pure TypeScript + Vite + PixiJS + Web Audio —
no framework, no server, no plugins. Runs entirely client-side and deploys as a static site.

> PRISMBEAT is an original, unofficial fan project. It is not affiliated with any commercial
> rhythm game or its publisher. See [Disclaimer](#disclaimer) below.

## Features

- **7 keys + turntable** play with tiered judgement (PGREAT / GREAT / GOOD / BAD / POOR),
  EX score, DJ rank, and combo/BP tracking
- **5 gauge types** (ASSIST EASY / EASY / NORMAL / HARD / EX-HARD) with clear lamps
- **Charge notes (CN)** — hold-to-the-tail notes with early-release penalty
- **Play options** — hi-speed (0.50–10.00), SUDDEN+ cover, RANDOM / MIRROR arrangement,
  autoplay demo, green-number visible-time readout
- **3 built-in original songs** (6 charts, levels 4–11) including a BPM-change + STOP showcase —
  all music is original and CC0
- **Practice mode** — grid pattern editor (snap 4–32, BPM 60–400), presets, seamless loop
  playback with metronome count-in, per-loop stats and a δ histogram
- **Records** — local best lamp/score/BP per chart, player statistics, JSON export/import
- **Settings** — key config, ±200ms global offset with tap calibration, per-bus volume
- Song preview on select, level folders, title/artist search, menu SFX, FPS/latency dev overlay

## Getting started

```bash
npm install
npm run dev        # local dev server
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
```

Quality gates:

```bash
npm run test       # headless unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run lint       # biome
```

Browser-level e2e verification (Playwright, drives the real game through
title → select → play → results → practice → settings):

```bash
npm run build && npm run preview -- --port 4173 &
node scripts/verify-e2e.mjs
node scripts/verify-records-e2e.mjs
```

## Default controls

| Context | Keys |
|---|---|
| Play | `Left Shift` turntable · `S` `D` `F` `Space` `J` `K` `L` keys 1–7 (rebindable in settings) |
| In play | `PageUp`/`PageDown` hi-speed · `Home` SUDDEN+ toggle · `↑`/`↓` cover height · `F1` dev overlay · `Esc` give up |
| Song select | `↑`/`↓` + `Enter` navigate · `G` gauge · `R` arrangement · `←`/`→` hi-speed · `A` autoplay · `S` sort · `F` level folders · `/` search · `P` practice · `O` settings |
| Everywhere | `Esc` back |

## Tech notes

- All game state is local: `localStorage` (settings, play options, records) and IndexedDB
  (practice patterns). Nothing leaves the browser.
- The audio clock (`AudioContext.currentTime`) is the single source of truth for song time;
  judgement, rendering, and the practice metronome all derive from it.
- Behavioral requirements live in `specs/`; `IMPLEMENTATION_PLAN.md` tracks the build.

## Licensing

- **Code** — [MIT](LICENSE).
- **Built-in songs** (audio, charts, metadata under `public/songs/`) — original works,
  programmatically generated for this project, dedicated to the public domain under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) as declared per song in
  `public/songs/index.json`.

## Disclaimer

PRISMBEAT is a free, open-source, non-commercial fan project made for learning and personal
enjoyment. It is **not affiliated with, endorsed by, or sponsored by Konami** or any other
game company. beatmania, beatmania IIDX, and BEMANI are trademarks of their respective
owners; they are referenced in documentation only to describe a game genre. This project
contains **no assets from any commercial game** — no music, sounds, graphics, fonts, or data
were taken from existing games; all songs and charts are original and generated for this
project.

PRISMBEAT는 학습과 취미 목적의 무료 오픈소스 비상업 팬 프로젝트입니다. **Konami를 포함한
어떤 게임 회사와도 무관하며, 공식 승인·후원을 받지 않았습니다.** 문서에 등장하는 상표는 각
소유자의 자산이며 장르 설명 목적으로만 언급됩니다. 이 프로젝트는 상용 게임의 음원·사운드·
그래픽·폰트·데이터를 일절 포함하지 않으며, 모든 곡과 채보는 이 프로젝트를 위해 창작된
원작물입니다.
