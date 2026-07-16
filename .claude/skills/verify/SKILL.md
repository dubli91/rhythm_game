---
name: verify
description: Build, launch, and drive the IIDX Web rhythm game in headless Chromium to verify changes at the real browser surface (title → select → play → results).
---

# Verify IIDX Web

Browser-only game (Vite + PixiJS + Web Audio). The surface is the browser; drive it
with Playwright (devDependency) against `vite preview`.

## Recipe that works

```bash
npm run build                                  # tsc --noEmit + vite build
(npm run preview -- --port 4173 > /tmp/preview.log 2>&1 &)
until curl -s http://localhost:4173/ >/dev/null; do sleep 0.5; done
LD_LIBRARY_PATH=/tmp/pwlibs/usr/lib/x86_64-linux-gnu node scripts/verify-e2e.mjs
```

`scripts/verify-e2e.mjs` walks: title → keypress unlock → song select → PLAY (real
keyboard input path, empty POORs) → Escape abandon → RESULTS (FAILED + give-up) →
autoplay retry (PGREATs, EX>0, gauge math) → retry-from-results → no residual
canvases → asserts zero page errors. Screenshots land in `/tmp/iidx-*.png`. Exit 0 = pass.

## Gotchas

- **Missing system libs (WSL, no sudo):** Playwright's chromium needs libnspr4/libnss3/
  libasound2. Without root: `apt-get download libnspr4 libnss3 libasound2t64`, then
  `dpkg -x <deb> /tmp/pwlibs` for each, and run node with
  `LD_LIBRARY_PATH=/tmp/pwlibs/usr/lib/x86_64-linux-gnu`. Re-download if /tmp was cleared.
  If `apt-get download` 404s (stale package lists, no sudo to update them), refresh into a
  user-writable dir: `mkdir -p /tmp/apt/lists/partial && apt-get -o Dir::State::Lists=/tmp/apt/lists update && apt-get -o Dir::State::Lists=/tmp/apt/lists download libasound2t64`.
- Launch args needed: `--autoplay-policy=no-user-gesture-required --enable-unsafe-swiftshader`
  (WebGL via swiftshader; "GPU stall due to ReadPixels" console warnings are benign).
- Don't `pkill -f 'vite preview'` — it matches the agent shell itself (exit 144). Kill by
  port: `ss -ltnp | grep 4173`.
- The e2e script must run from the repo root (resolves the `playwright` package).
- First notes start at beat 16 (6.4s at BPM 150) + 1s lead-in — wait ≥10s of autoplay
  before expecting PGREATs.
- Sanity anchor: NORMAL gauge after N autoplay PGREATs = 22 + N × (total/noteCount).
