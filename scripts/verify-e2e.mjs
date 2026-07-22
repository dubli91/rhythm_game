import { chromium } from 'playwright';

const BASE = 'http://localhost:4173/';
const SHOT = (n) => `/tmp/iidx-${n}.png`;
const errors = [];
const consoleMsgs = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  consoleMsgs.push(`[${m.type()}] ${m.text()}`);
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`STEP OK: ${name}`);
  } catch (e) {
    console.log(`STEP FAIL: ${name}: ${e.message}`);
    await page.screenshot({ path: SHOT(`fail-${name.replace(/\W+/g, '_')}`) }).catch(() => {});
    throw e;
  }
};

await step('load title', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.press-key', { timeout: 5000 });
  await page.screenshot({ path: SHOT('1-title') });
});

// Moves the cursor down until the selected row is the song row for `title`.
const navigateToSong = async (title) => {
  for (let i = 0; i < 40; i++) {
    const { text, isSong } = await page.$eval('.song-list li.selected', (n) => ({
      text: n.textContent,
      isSong: n.classList.contains('song-row'),
    }));
    if (isSong && text.includes(title)) return;
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`could not navigate to song "${title}"`);
};

await step('unlock -> song select (grouped list, >=3 built-in songs)', async () => {
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  const songs = await page.$$eval('.song-list li.song-row', (ls) => ls.map((l) => l.textContent));
  console.log('  songs listed:', JSON.stringify(songs));
  if (songs.length < 3) throw new Error(`expected >=3 built-in songs, got ${songs.length}`);
  await page.screenshot({ path: SHOT('2-select') });
});

// Song preview (song-select.md SHOULD 12): the shell mirrors the preview
// player's state onto data attributes of the select screen root.
const previewAttrs = () =>
  page.$eval('[data-screen="SONG_SELECT"]', (n) => ({
    state: n.dataset.previewState ?? '',
    song: n.dataset.previewSong ?? '',
  }));
const waitForPreview = (state, song) =>
  page.waitForFunction(
    ([s, id]) => {
      const n = document.querySelector('[data-screen="SONG_SELECT"]');
      return n?.dataset.previewState === s && (id === null || n?.dataset.previewSong === id);
    },
    [state, song],
    { timeout: 8000 },
  );

await step('song preview: plays on cursor settle, follows the song, stops off-screen', async () => {
  // Cursor starts on the first song row — Chord Dojo 282 under TITLE sort, which
  // has NO preview metadata (keysound practice song): the preview must stay idle
  // (song-select.md SHOULD 12). 800ms > the 300ms settle debounce, so a wrongly
  // started preview would already be visible.
  await page.waitForTimeout(800);
  const onDojo = await previewAttrs();
  if (onDojo.state !== 'idle')
    throw new Error(`practice song must not preview, got ${JSON.stringify(onDojo)}`);
  await page.keyboard.press('ArrowDown'); // next song row: First Light
  await waitForPreview('playing', 'song-6f90aea6');
  console.log(`  preview after settle: ${JSON.stringify(await previewAttrs())}`);
  await page.keyboard.press('ArrowDown'); // next song row: Neon Cascade
  await waitForPreview('playing', 'song-720e0160');
  console.log(`  preview after move: ${JSON.stringify(await previewAttrs())}`);
  await page.keyboard.press('KeyO'); // settings entry must silence the preview
  await page.waitForSelector('[data-screen="SETTINGS"].active', { timeout: 5000 });
  const inSettings = await previewAttrs();
  if (inSettings.state !== 'idle')
    throw new Error(`preview should stop outside select, got ${JSON.stringify(inSettings)}`);
  await page.keyboard.press('Escape'); // back to select -> resumes from the decode cache
  await waitForPreview('playing', 'song-720e0160');
  console.log('  preview resumed after settings round-trip');
});

await step('expand First Light -> chart rows appear, first chart selected', async () => {
  await navigateToSong('First Light');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
  const selected = await page.$eval('.song-list li.selected', (n) => ({
    text: n.textContent,
    isChart: n.classList.contains('chart-row'),
  }));
  console.log('  selected after expand:', JSON.stringify(selected));
  if (!selected.isChart || !selected.text.includes('NORMAL'))
    throw new Error('expected the NORMAL chart row to be selected after expanding');
  await page.screenshot({ path: SHOT('2b-expanded') });
});

await step('network check: chart/audio not yet fetched at select', async () => {
  // spec builtin-song-content MUST 13 is about app start; by now only index.json should have loaded
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  page._reqs = reqs;
});

await step('enter PLAY (manual)', async () => {
  await page.keyboard.press('Enter');
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await page.waitForTimeout(2500); // lead-in 1s + scroll-in
  await page.screenshot({ path: SHOT('3-play-early') });
});

await step('mash keys during play (real input path)', async () => {
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('KeyS');
    await page.keyboard.press('KeyF');
    await page.keyboard.press('Space');
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: SHOT('4-play-mash') });
});

await step(
  'dev overlay: F1 toggles FPS + input-latency readout (SHOULD 16 / SHOULD 10)',
  async () => {
    // The overlay text is canvas-drawn, so the controller mirrors it onto the
    // play mount's data-dev-overlay attribute (same pattern as preview state).
    const before = await page.$eval('[data-screen="PLAY"]', (n) => n.dataset.devOverlay ?? '');
    if (before !== '') throw new Error(`overlay visible before toggle: ${JSON.stringify(before)}`);
    await page.keyboard.press('F1');
    // FPS publishes after a 500ms window; wait for a real figure, not the — placeholder.
    await page.waitForFunction(
      () => {
        const text = document.querySelector('[data-screen="PLAY"]')?.dataset?.devOverlay ?? '';
        return /FPS \d/.test(text) && text.includes('FRAME ');
      },
      { timeout: 5000 },
    );
    // A real keypress must produce a latency sample (keydown → judgement processed).
    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      () => {
        const text = document.querySelector('[data-screen="PLAY"]')?.dataset?.devOverlay ?? '';
        return /INPUT \d+\.\dms/.test(text) && /AVG \d+\.\dms \(\d+\)/.test(text);
      },
      { timeout: 5000 },
    );
    const overlay = await page.$eval('[data-screen="PLAY"]', (n) => n.dataset.devOverlay);
    console.log(`  overlay: ${overlay.replace(/\n/g, ' | ')}`);
    await page.screenshot({ path: SHOT('4b-dev-overlay') });
    await page.keyboard.press('F1');
    await page.waitForFunction(
      () => (document.querySelector('[data-screen="PLAY"]')?.dataset?.devOverlay ?? '') === '',
      { timeout: 5000 },
    );
  },
);

await step('Escape abandons -> RESULTS with give-up', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.result-status', { timeout: 8000 });
  const status = await page.$eval('.result-status', (n) => n.textContent);
  const sub = await page.$eval('.result-sub', (n) => n.textContent);
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  console.log(`  results: ${status} | ${sub}`);
  console.log(`  grid: ${grid}`);
  if (status !== 'FAILED') throw new Error(`expected FAILED, got ${status}`);
  if (!sub.includes('give-up')) throw new Error('missing give-up indicator');
  await page.screenshot({ path: SHOT('5-results-abandon') });
});

await step('canvas removed after leaving PLAY', async () => {
  const canvases = await page.$$('canvas');
  console.log(`  canvas count on results: ${canvases.length}`);
});

await step('ESC back to select, FAILED lamp shown, enable AUTOPLAY, retry', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
  // Lamp display must reflect the just-written record (song-select.md acceptance 3).
  const selectedRow = await page.$eval('.song-list li.selected', (n) => n.textContent);
  console.log(`  selected row after play: ${selectedRow}`);
  if (!selectedRow.includes('FAILED')) throw new Error('FAILED lamp missing on chart row');
  await page.keyboard.press('KeyA'); // autoplay ON
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  console.log(`  options bar: ${bar}`);
  if (!bar.includes('ON')) throw new Error('autoplay toggle not reflected');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await page.waitForTimeout(16000); // ~intro + first notes at beat 16 (6.4s) + a stretch of perfect play
  await page.screenshot({ path: SHOT('6-autoplay-mid') });
});

await step('abandon autoplay -> results shows EX gained + no-record note', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.result-status', { timeout: 8000 });
  const sub = await page.$eval('.result-sub', (n) => n.textContent);
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  console.log(`  sub: ${sub}`);
  console.log(`  grid: ${grid}`);
  if (!sub.includes('AUTOPLAY')) throw new Error('missing autoplay notice');
  const exMatch = grid.match(/EX SCORE(\d+)/);
  const ex = exMatch ? Number(exMatch[1]) : Number.NaN;
  console.log(`  parsed EX: ${ex}`);
  if (!(ex > 0)) throw new Error(`autoplay EX score should be > 0, got ${ex}`);
  if (grid.includes('PGREAT0')) throw new Error('autoplay produced zero PGREATs');
  // All-PGREAT perfect play is never FAST/SLOW-classified (judgement-scoring
  // acceptance: autoplay counts are always 0), yet the rows must still render.
  if (!grid.includes('FAST0SLOW0'))
    throw new Error(`autoplay FAST/SLOW counts should both read 0: ${grid}`);
  // δ histogram (judgement-scoring SHOULD 13): autoplay hits land at exactly δ=0,
  // so the sparkline is a single full-height center column (bucket 8 of 15).
  const histogram = await page.$eval('.result-histogram', (n) => n.textContent);
  console.log(`  histogram: ${JSON.stringify(histogram)}`);
  if (!/^δ −75ms {8}█ {8}\+75ms$/.test(histogram))
    throw new Error(
      `autoplay histogram should be a lone center column: ${JSON.stringify(histogram)}`,
    );
  await page.screenshot({ path: SHOT('7-results-autoplay') });
});

await step('retry from results (Enter) then abandon', async () => {
  await page.keyboard.press('Enter');
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.result-status', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
});

await step('repeat PLAY->RESULTS->SELECT leaves no extra canvases', async () => {
  const canvases = await page.$$('canvas');
  console.log(`  canvas count back on select: ${canvases.length}`);
  if (canvases.length > 0) throw new Error(`residual canvases: ${canvases.length}`);
});

await step('sort modes cycle (S) and persist to select.v1', async () => {
  const sortText = () => page.$eval('.sort-line', (n) => n.textContent);
  if (!(await sortText()).includes('TITLE')) throw new Error('default sort should be TITLE');
  await page.keyboard.press('KeyS');
  if (!(await sortText()).includes('LEVEL')) throw new Error('sort did not cycle to LEVEL');
  await page.keyboard.press('KeyS');
  if (!(await sortText()).includes('LAMP')) throw new Error('sort did not cycle to LAMP');
  const persisted = await page.evaluate(() => localStorage.getItem('select.v1'));
  console.log(`  select.v1: ${persisted}`);
  if (!persisted || !persisted.includes('lamp')) throw new Error('sort mode not persisted');
  await page.keyboard.press('KeyS'); // back to TITLE for a clean end state
  await page.screenshot({ path: SHOT('8-sorted') });
});

await step('search (/): filters live, owns the keyboard while focused (SHOULD 11)', async () => {
  await page.keyboard.press('Slash');
  const focused = await page.evaluate(() => document.activeElement?.dataset?.role ?? '');
  if (focused !== 'select-search')
    throw new Error(`Slash should focus the search box, got "${focused}"`);
  await page.keyboard.type('neon');
  const titles = await page.$$eval('.song-list li.song-row', (ls) => ls.map((l) => l.textContent));
  if (titles.length !== 1 || !titles[0].includes('Neon Cascade'))
    throw new Error(
      `filter "neon" should leave exactly Neon Cascade, got ${JSON.stringify(titles)}`,
    );
  let line = await page.$eval('.sort-line', (n) => n.textContent);
  if (!line.includes('1 SONG')) throw new Error(`match count missing from readout: ${line}`);
  // While typing, menu bindings must NOT fire: this 's' extends the filter (zero matches)
  // instead of cycling the sort (app-shell-navigation.md MUST 17).
  await page.keyboard.type('s');
  const rowCount = await page.$$eval('.song-list li', (ls) => ls.length);
  if (rowCount !== 0)
    throw new Error(`zero-match filter should empty the list, got ${rowCount} rows`);
  line = await page.$eval('.sort-line', (n) => n.textContent);
  if (!line.includes('SORT TITLE')) throw new Error(`typing "s" must not cycle sort: ${line}`);
  await page.keyboard.press('Backspace'); // back to "neon" -> 1 song
  await page.screenshot({ path: SHOT('8b-search') });
  await page.keyboard.press('Escape'); // blurs the box, keys return to the list
  const stillFocused = await page.evaluate(() => document.activeElement?.dataset?.role ?? '');
  if (stillFocused === 'select-search') throw new Error('Escape should blur the search box');
  await page.keyboard.press('KeyS'); // proves list bindings are live again
  line = await page.$eval('.sort-line', (n) => n.textContent);
  if (!line.includes('SORT LEVEL')) throw new Error(`S after blur should cycle sort: ${line}`);
  await page.keyboard.press('KeyS');
  await page.keyboard.press('KeyS'); // back to TITLE
  // Clear the filter for the steps that follow.
  await page.keyboard.press('Slash');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  const songCount = await page.$$eval('.song-list li.song-row', (ls) => ls.length);
  if (songCount !== 4)
    throw new Error(`clearing the filter should restore 4 songs, got ${songCount}`);
});

await step(
  'level folder view (F): charts group by level, persists to select.v1 (SHOULD 13)',
  async () => {
    await page.keyboard.press('KeyF');
    const line = await page.$eval('.sort-line', (n) => n.textContent);
    if (!line.includes('LEVEL FOLDERS'))
      throw new Error(`readout should show LEVEL FOLDERS: ${line}`);
    // Catalog levels: FL N4/H7, NC N6/H8, OC H9/A11, Chord Dojo A12 ->
    // folders 4,6,7,8,9,11,12 with 1 chart each.
    const folders = await page.$$eval('.song-list li.folder-row .folder-title', (ls) =>
      ls.map((l) => l.textContent),
    );
    console.log(`  folders: ${JSON.stringify(folders)}`);
    const levels = folders.map((f) => f.replace('LEVEL ', ''));
    if (levels.join(',') !== '4,6,7,8,9,11,12')
      throw new Error(`expected folders 4,6,7,8,9,11,12 ascending, got ${levels.join(',')}`);
    const persisted = await page.evaluate(() => localStorage.getItem('select.v1'));
    if (!persisted || !persisted.includes('"viewMode":"level"'))
      throw new Error(`viewMode not persisted: ${persisted}`);
    await page.keyboard.press('Enter'); // expand LEVEL 4 -> its one chart, selected
    const selected = await page.$eval('.song-list li.selected', (n) => ({
      text: n.textContent,
      isChart: n.classList.contains('chart-row'),
    }));
    console.log(`  selected in folder: ${JSON.stringify(selected)}`);
    if (
      !selected.isChart ||
      !selected.text.includes('First Light') ||
      !selected.text.includes('NORMAL')
    )
      throw new Error(
        'LEVEL 4 folder should open onto First Light NORMAL with the song named on the row',
      );
    await page.screenshot({ path: SHOT('8c-folders') });
    await page.keyboard.press('Escape'); // collapse the folder
    const chartRows = await page.$$eval('.song-list li.chart-row', (ls) => ls.length);
    if (chartRows !== 0) throw new Error('Escape should collapse the folder');
    await page.keyboard.press('KeyF'); // back to song view for the steps that follow
    const doc = await page.evaluate(() => localStorage.getItem('select.v1'));
    if (!doc || !doc.includes('"viewMode":"song"'))
      throw new Error(`toggling back should persist song view: ${doc}`);
  },
);

await step('hi-speed adjust from options panel persists (+ GREEN readout)', async () => {
  await navigateToSong('First Light'); // 150 BPM constant — deterministic GREEN
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  console.log(`  options bar: ${bar}`);
  if (!bar.includes('1.50')) throw new Error('hi-speed should read 1.50 after two +0.25 steps');
  // Green number (play-options.md SHOULD 13): 600px / (130 × 1.5 × 150/60000) = 1231ms.
  if (!bar.includes('GREEN 1231'))
    throw new Error('GREEN should read 1231 at BPM 150 / HS 1.50 / no cover');
  const doc = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
  if (!doc || !doc.includes('1.5')) throw new Error('hi-speed not persisted');
});

await step('arrangement + SUDDEN+ from options panel persist', async () => {
  await page.keyboard.press('KeyR'); // OFF -> RANDOM
  let bar = await page.$eval('.options-bar', (n) => n.textContent);
  if (!bar.includes('RANDOM')) throw new Error('arrange should read RANDOM after R');
  await page.keyboard.press('Home'); // SUDDEN+ ON (default cover 30%)
  await page.keyboard.press('PageUp'); // 31
  await page.keyboard.press('PageUp'); // 32
  bar = await page.$eval('.options-bar', (n) => n.textContent);
  console.log(`  options bar: ${bar}`);
  if (!bar.includes('SUDDEN+ 32%'))
    throw new Error('sudden+ should read 32% after Home + 2x PageUp');
  // Cover shrinks the visible run: 600×0.68px / (130 × 1.5 × 150/60000) = 837ms.
  if (!bar.includes('GREEN 837'))
    throw new Error('GREEN should account for the 32% cover (expected 837)');
  const doc = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
  console.log(`  playOptions.v1: ${doc}`);
  if (!doc || !doc.includes('"arrangement":"RANDOM"')) throw new Error('arrangement not persisted');
  if (!doc.includes('"suddenPlusCover":32')) throw new Error('cover not persisted');
});

await step('GREEN uses the max BPM of a soflan song on select', async () => {
  // Neon Cascade is 140-175: the readout must use 175 (play-options.md SHOULD 13
  // implementation decision), i.e. 408px visible / (130 × 1.5 × 175/60000) = 717ms —
  // the min-BPM figure would be 897.
  await navigateToSong('Neon Cascade');
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  console.log(`  options bar: ${bar}`);
  if (!bar.includes('GREEN 717'))
    throw new Error('GREEN should derive from the song MAX BPM (expected 717)');
});

await step('in-play option keys adjust hi-speed/cover; results + persistence', async () => {
  // Collapse back to the song row so navigateToSong starts from a clean state.
  await page.keyboard.press('Escape');
  await navigateToSong('First Light');
  await page.keyboard.press('Enter'); // expand
  await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
  await page.keyboard.press('Enter'); // play (autoplay still ON, RANDOM + SUD+ 32%)
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.keyboard.press('PageUp'); // hi-speed 1.50 -> 1.75
  await page.keyboard.press('ArrowDown'); // cover 32 -> 31
  await page.keyboard.press('ArrowDown'); // cover 31 -> 30
  await page.screenshot({ path: SHOT('11-inplay-options') });
  // Let autoplay reach the first notes so the RANDOM-invariance check below is real.
  await page.waitForTimeout(6000);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.result-status', { timeout: 8000 });
  const sub = await page.$eval('.result-sub', (n) => n.textContent);
  console.log(`  sub: ${sub}`);
  if (!sub.includes('HS 1.75')) throw new Error('results should show adjusted HS 1.75');
  if (!sub.includes('RANDOM')) throw new Error('results should show RANDOM');
  if (!sub.includes('SUD+ 30%')) throw new Error('results should show SUD+ 30%');
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  if (grid.includes('PGREAT0'))
    throw new Error('RANDOM autoplay produced zero PGREATs (lane substitution broke judgement)');
  const doc = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
  console.log(`  playOptions.v1: ${doc}`);
  if (!doc.includes('"hiSpeed":1.75')) throw new Error('adjusted hi-speed not persisted');
  if (!doc.includes('"suddenPlusCover":30')) throw new Error('adjusted cover not persisted');
  await page.keyboard.press('Escape'); // back to select
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
  await page.keyboard.press('Escape'); // collapse for the next navigate
  await page.screenshot({ path: SHOT('12-after-inplay-options') });
});

await step(
  'green-number lock: seed + AUTO readout + soflan HUD invariance + persistence (play-options MUST 15-17)',
  async () => {
    await page.keyboard.press('Home'); // SUDDEN+ 30% -> OFF so figures are cover-free
    await navigateToSong('Neon Cascade'); // 140-175 soflan; select GREEN uses max BPM 175
    let bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('G-LOCK OFF')) throw new Error(`G-LOCK should default OFF: ${bar}`);
    // Toggle ON: the target seeds from the current manual green so the feel
    // doesn't jump — HS 1.75 @175 BPM = 904ms, snapped to the 10ms grid = 900.
    await page.keyboard.press('KeyL');
    bar = await page.$eval('.options-bar', (n) => n.textContent);
    console.log(`  options bar: ${bar}`);
    if (!bar.includes('G-LOCK 900ms'))
      throw new Error(`lock should seed 900ms from HS 1.75 @175: ${bar}`);
    if (!bar.includes('GREEN 900'))
      throw new Error(`GREEN should show the (unclamped) target under lock: ${bar}`);
    if (!bar.includes('HI-SPEED AUTO'))
      throw new Error(`HI-SPEED should read AUTO under lock: ${bar}`);
    // Locked arrows adjust the target: → = faster = −10ms (mirrors in-play PageUp).
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('G-LOCK 880ms') || !bar.includes('GREEN 880'))
      throw new Error(`arrows should step the locked target to 880: ${bar}`);

    // Play through the 140→175 change (beat 64 ≈ 28.4s incl. lead-in): the HUD
    // green (mirrored to data-green) must hold the target on BOTH sides.
    await page.keyboard.press('Enter'); // expand
    await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
    await page.keyboard.press('Enter'); // play NORMAL (autoplay still ON)
    await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
    await page.waitForTimeout(3000); // BPM 140 section
    const green140 = await page.$eval('[data-screen="PLAY"]', (n) => n.dataset.green ?? '');
    if (green140 !== '880')
      throw new Error(`HUD green should hold the 880 target at BPM 140, got "${green140}"`);
    await page.waitForTimeout(28000); // past the STOP into the 175 section
    const green175 = await page.$eval('[data-screen="PLAY"]', (n) => n.dataset.green ?? '');
    if (green175 !== '880')
      throw new Error(`HUD green should hold 880 through the BPM change, got "${green175}"`);
    await page.screenshot({ path: SHOT('12b-green-lock-play') });
    // In-play PageUp adjusts the TARGET under lock (faster = −10ms), not hi-speed.
    await page.keyboard.press('PageUp');
    await page.waitForFunction(
      () => document.querySelector('[data-screen="PLAY"]')?.dataset?.green === '870',
      { timeout: 5000 },
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('.result-status', { timeout: 8000 });
    const doc = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
    console.log(`  playOptions.v1: ${doc}`);
    if (!doc.includes('"greenLockEnabled":true')) throw new Error('lock ON not persisted');
    if (!doc.includes('"greenLockTargetMs":870'))
      throw new Error('in-play target adjustment not persisted');
    // Manual hi-speed must survive locked play untouched (PageUp adjusted the target).
    if (!doc.includes('"hiSpeed":1.75')) throw new Error('manual hi-speed should be untouched');
    await page.keyboard.press('Escape'); // back to select
    await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
    await page.keyboard.press('Escape'); // collapse
    bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('G-LOCK 870ms'))
      throw new Error(`select bar should show the adjusted target: ${bar}`);
    await page.keyboard.press('KeyL'); // lock OFF for the steps that follow
    bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('G-LOCK OFF') || !bar.includes('HI-SPEED 1.75'))
      throw new Error(`toggling off should restore manual hi-speed display: ${bar}`);
    const doc2 = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
    if (!doc2.includes('"greenLockEnabled":false')) throw new Error('lock OFF not persisted');
  },
);

// --- FAST/SLOW timing indicator (judgement-scoring MUST 14-16, play-options
// MUST 18, playfield-rendering MUST 18, results-records MUST 13) ---

await step(
  'timing display: default FAST/SLOW, KeyT cycles, persisted (play-options MUST 18)',
  async () => {
    let bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('TIMING FAST/SLOW'))
      throw new Error(`TIMING should default to FAST/SLOW: ${bar}`);
    await page.keyboard.press('KeyT');
    bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('TIMING ±ms')) throw new Error(`KeyT should cycle to ±ms: ${bar}`);
    await page.keyboard.press('KeyT');
    bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('TIMING OFF')) throw new Error(`KeyT should cycle to OFF: ${bar}`);
    const doc = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
    if (!doc.includes('"timingDisplay":"OFF"'))
      throw new Error(`timing mode not persisted: ${doc}`);
    await page.keyboard.press('KeyT'); // wrap back to the default
    bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('TIMING FAST/SLOW'))
      throw new Error(`cycle should wrap to FAST/SLOW: ${bar}`);
    const doc2 = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
    if (!doc2.includes('"timingDisplay":"FAST_SLOW"'))
      throw new Error(`wrapped mode not persisted: ${doc2}`);
  },
);

// The canvas indicator mirrors to data-timing on the PLAY mount (same pattern as
// data-green). It lives only 500ms per judgement, so poll-based reads race it —
// a MutationObserver records every non-empty value it ever showed instead.
const armTimingObserver = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-screen="PLAY"]');
    window.__timingObs?.disconnect();
    window.__timingSeen = [];
    window.__timingObs = new MutationObserver(() => {
      const v = el.dataset.timing ?? '';
      if (v !== '' && !window.__timingSeen.includes(v)) window.__timingSeen.push(v);
    });
    window.__timingObs.observe(el, { attributes: true, attributeFilter: ['data-timing'] });
  });
const timingSeen = () => page.evaluate(() => window.__timingSeen ?? []);
// Round-robin over every lane, PACED at 60ms/press: a full cycle (8 × 60ms =
// 480ms) still fits inside a note's ±250ms window, so any note that scrolls by
// is consumed by SOME press — and a mash-timed consuming press is essentially
// never PGREAT, so it classifies. The pacing is load-bearing: the very next
// press is usually an empty POOR, which correctly CLEARS the indicator
// (MUST 18), so a classified value only lives press-to-press. 60ms exceeds the
// frame period even at degraded headless fps, guaranteeing the data-timing
// mirror samples it; full-speed mashing cleared values within ~12ms and made
// the observer miss every hit (grid FAST counts nonzero, seen[] empty).
const mashAllLanes = async (seconds) => {
  const codes = ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'ShiftLeft'];
  const until = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < until) {
    await page.keyboard.press(codes[i++ % codes.length]);
    await page.waitForTimeout(60);
  }
};
const enterFirstLightPlay = async () => {
  await navigateToSong('First Light');
  await page.keyboard.press('Enter'); // expand
  await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
  await page.keyboard.press('Enter'); // play NORMAL
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await armTimingObserver();
};
const exitToCollapsedSelect = async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
  await page.keyboard.press('Escape'); // collapse for the next navigateToSong
};

await step(
  'FAST/SLOW mode: real hits display, empty POORs never do (rendering MUST 18)',
  async () => {
    await page.keyboard.press('KeyA'); // autoplay OFF — the indicator needs real input
    const bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('AUTOPLAY OFF')) throw new Error(`autoplay should be OFF: ${bar}`);
    await enterFirstLightPlay();
    // Before beat 16 (6.4s + 1s lead-in) there are no notes: a press is an empty
    // POOR, which is unclassified and must not display (MUST 18 clear rule).
    await page.waitForTimeout(2500);
    await page.keyboard.press('KeyS');
    await page.waitForTimeout(300);
    const idle = await page.$eval('[data-screen="PLAY"]', (n) => n.dataset.timing ?? '');
    if (idle !== '') throw new Error(`empty POOR must not display timing, got "${idle}"`);
    if ((await timingSeen()).length !== 0)
      throw new Error('no classified judgement yet, but the indicator fired');
    // Mash across the first note section: consumed notes yield FAST/SLOW words.
    await page.waitForTimeout(4500);
    await mashAllLanes(6);
    const seen = await timingSeen();
    console.log(`  indicator values seen: ${JSON.stringify(seen)}`);
    if (!seen.some((v) => v === 'FAST' || v === 'SLOW'))
      throw new Error(`expected FAST/SLOW to display during mash, saw ${JSON.stringify(seen)}`);
    if (!seen.every((v) => v === 'FAST' || v === 'SLOW'))
      throw new Error(`FAST/SLOW mode must only show the words, saw ${JSON.stringify(seen)}`);
    await page.screenshot({ path: SHOT('12c-timing-fastslow') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.result-status', { timeout: 8000 });
    const grid = await page.$eval('.result-grid', (n) => n.textContent);
    console.log(`  grid: ${grid}`);
    const m = grid.match(/FAST(\d+)SLOW(\d+)/);
    if (!m) throw new Error(`results grid missing FAST/SLOW rows: ${grid}`);
    if (!(Number(m[1]) + Number(m[2]) > 0))
      throw new Error(`mash play should classify at least one hit: ${grid}`);
    await page.keyboard.press('Escape');
    await exitToCollapsedSelect();
  },
);

await step('±ms mode: indicator shows the signed δ integer (rendering MUST 18)', async () => {
  await page.keyboard.press('KeyT'); // FAST/SLOW -> ±ms
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  if (!bar.includes('TIMING ±ms')) throw new Error(`mode should read ±ms: ${bar}`);
  await enterFirstLightPlay();
  await page.waitForTimeout(7000); // reach the first notes
  await mashAllLanes(6);
  const seen = await timingSeen();
  console.log(`  indicator values seen: ${JSON.stringify(seen)}`);
  if (!seen.some((v) => /^[+-]\d+ms$/.test(v)))
    throw new Error(`expected signed ms values, saw ${JSON.stringify(seen)}`);
  if (!seen.every((v) => /^[+-]\d+ms$/.test(v)))
    throw new Error(`±ms mode must only show δ values, saw ${JSON.stringify(seen)}`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.result-status', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await exitToCollapsedSelect();
});

await step(
  'OFF mode: never displays, but still aggregates to results (results MUST 13)',
  async () => {
    await page.keyboard.press('KeyT'); // ±ms -> OFF
    const bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('TIMING OFF')) throw new Error(`mode should read OFF: ${bar}`);
    await enterFirstLightPlay();
    await page.waitForTimeout(7000);
    await mashAllLanes(6);
    const seen = await timingSeen();
    if (seen.length !== 0)
      throw new Error(`OFF mode must never display, saw ${JSON.stringify(seen)}`);
    const attr = await page.$eval('[data-screen="PLAY"]', (n) => n.dataset.timing ?? '');
    if (attr !== '') throw new Error(`OFF mode left data-timing set: "${attr}"`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.result-status', { timeout: 8000 });
    const grid = await page.$eval('.result-grid', (n) => n.textContent);
    console.log(`  grid: ${grid}`);
    const m = grid.match(/FAST(\d+)SLOW(\d+)/);
    if (!m) throw new Error(`OFF-mode results must still show FAST/SLOW rows: ${grid}`);
    if (!(Number(m[1]) + Number(m[2]) > 0))
      throw new Error(`OFF mode must still aggregate (MUST 16), got zeros: ${grid}`);
    await page.screenshot({ path: SHOT('12d-timing-off-results') });
    await page.keyboard.press('Escape');
    await exitToCollapsedSelect();
    await page.keyboard.press('KeyT'); // restore the FAST/SLOW default
    await page.keyboard.press('KeyA'); // autoplay back ON for the play smokes below
    const restored = await page.$eval('.options-bar', (n) => n.textContent);
    if (!restored.includes('TIMING FAST/SLOW') || !restored.includes('AUTOPLAY ON'))
      throw new Error(`restore failed: ${restored}`);
  },
);

// Lazy-load + play smoke for the OTHER built-in songs: exercises per-song chart/
// audio fetch on demand and the renderer against the multi-BPM chart (Neon
// Cascade, 140->175->140 + STOP) and the densest chart (Overdrive Core ANOTHER,
// 710 notes). Autoplay is still ON from the earlier step -> perfect-play smoke.
const playSmoke = async (title, difficulty, seconds) => {
  await navigateToSong(title);
  await page.keyboard.press('Enter'); // expand
  await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
  for (let i = 0; i < 6; i++) {
    const selected = await page.$eval('.song-list li.selected', (n) => n.textContent);
    if (selected.includes(difficulty)) break;
    await page.keyboard.press('ArrowDown');
  }
  const chartRow = await page.$eval('.song-list li.selected', (n) => n.textContent);
  if (!chartRow.includes(difficulty))
    throw new Error(`could not select ${difficulty} of ${title}, at "${chartRow}"`);
  await page.keyboard.press('Enter'); // play
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.result-status', { timeout: 8000 });
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  console.log(`  ${title} ${difficulty} grid: ${grid}`);
  if (grid.includes('PGREAT0')) throw new Error(`autoplay on ${title} produced zero PGREATs`);
  await page.keyboard.press('Escape'); // back to select
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
  await page.keyboard.press('Escape'); // collapse so the next navigate starts clean
  return grid;
};

await step(
  'play smoke: Neon Cascade NORMAL (BPM-change/STOP + CN chart) loads + autoplays through the riser CN',
  async () => {
    // 30s reaches past the riser CN (head at beat 60 ≈ 26.7s incl. 1s lead-in) whose
    // held body crosses the STOP + BPM change, and the hold auto-completes at the
    // tail. Autoplay never releases, so ANY BAD/POOR/BP here means the CN pipeline
    // (head judgement, hold auto-complete, or renderer during the frozen scroll)
    // broke — a cnBreak would surface in the BP row.
    const grid = await playSmoke('Neon Cascade', 'NORMAL', 30);
    if (!grid.includes('BAD0POOR (miss)0POOR (empty)0FAST0SLOW0BP0'))
      throw new Error(`CN-chart autoplay produced non-clean counts: ${grid}`);
    await page.screenshot({ path: SHOT('9-neon-smoke') });
  },
);

await step('cycle arrangement to MIRROR for the dense-chart smoke', async () => {
  await page.keyboard.press('KeyR'); // RANDOM -> MIRROR
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  console.log(`  options bar: ${bar}`);
  if (!bar.includes('MIRROR')) throw new Error('arrange should read MIRROR');
});

await step('play smoke: Overdrive Core ANOTHER (densest chart) loads + autoplays', async () => {
  await playSmoke('Overdrive Core', 'ANOTHER', 8);
  await page.screenshot({ path: SHOT('10-overdrive-smoke') });
});

// --- Practice song (practice-song-content.md acceptance criteria) ---
// A no-BGM built-in song: the play path fetches chart + keysound.ogg only (never
// a BGM track), the session ends naturally at last note + 2s, and records ride
// the normal path — autoplay writes nothing, a real play writes playCount.

await step('practice song: 1-slot entry on select, ANOTHER 12 / 182 notes', async () => {
  await page.keyboard.press('KeyR'); // MIRROR -> OFF: acceptance runs on the raw chart
  await navigateToSong('Chord Dojo 282');
  await page.keyboard.press('Enter'); // expand
  await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
  const chartRows = await page.$$eval('.song-list li.chart-row', (ls) =>
    ls.map((l) => l.textContent),
  );
  console.log(`  dojo chart rows: ${JSON.stringify(chartRows)}`);
  if (chartRows.length !== 1) throw new Error('practice song must have exactly 1 chart row');
  if (!chartRows[0].includes('ANOTHER') || !chartRows[0].includes('12'))
    throw new Error(`expected ANOTHER 12, got ${chartRows[0]}`);
  if (!chartRows[0].includes('182')) throw new Error(`expected 182 notes, got ${chartRows[0]}`);
});

await step(
  'practice song: autoplay run — keysound fetched, NO BGM request, natural end',
  async () => {
    const reqs = [];
    const onReq = (r) => reqs.push(r.url());
    page.on('request', onReq);
    await page.keyboard.press('Enter'); // play (autoplay still ON from the smokes)
    await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
    // Natural completion: 1s lead-in + 13.4s chart (64 beats @282) + 2s tail + result delay.
    await page.waitForSelector('.result-status', { timeout: 30000 });
    page.off('request', onReq);
    const dojoReqs = reqs.filter((u) => u.includes('song-19d6fdce'));
    console.log(`  dojo requests: ${JSON.stringify(dojoReqs)}`);
    if (!dojoReqs.some((u) => u.endsWith('keysound.ogg')))
      throw new Error('keysound.ogg must be preloaded at song decision (MUST 10)');
    if (dojoReqs.some((u) => u.includes('audio')))
      throw new Error(
        `practice song must never fetch a BGM track, got ${JSON.stringify(dojoReqs)}`,
      );
    const grid = await page.$eval('.result-grid', (n) => n.textContent);
    console.log(`  dojo autoplay grid: ${grid}`);
    // 182 perfect hits and a clean count row prove the silent master clock judges
    // exactly like the BGM path (t0 reservation + advance-driven completion).
    if (!grid.includes('PGREAT182'))
      throw new Error(`autoplay should PGREAT all 182 notes: ${grid}`);
    if (!grid.includes('BAD0POOR (miss)0POOR (empty)0FAST0SLOW0BP0'))
      throw new Error(`autoplay run must be clean: ${grid}`);
    const rec = await page.evaluate(() => localStorage.getItem('records.v1'));
    if (rec?.includes('song-19d6fdce'))
      throw new Error('autoplay must not write a practice-song record');
    await page.screenshot({ path: SHOT('10b-dojo-autoplay') });
    await page.keyboard.press('Escape'); // back to select
    await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
    await page.keyboard.press('Escape'); // collapse for the next navigate
  },
);

await step('practice song: real input plays keysounds + abandon writes a record', async () => {
  await page.keyboard.press('KeyA'); // autoplay OFF — real presses must judge + keysound
  await navigateToSong('Chord Dojo 282');
  await page.keyboard.press('Enter'); // expand
  await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
  await page.keyboard.press('Enter'); // play
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await page.waitForTimeout(2200); // through the lead-in, into the A section
  // Real presses drive the keysound trigger path (hit AND emptyPoor kinds); any
  // scheduling error would surface as a page error and fail the run.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('KeyS');
    await page.keyboard.press('Space');
    await page.keyboard.press('ShiftLeft');
    await page.waitForTimeout(120);
  }
  await page.keyboard.press('Escape'); // abandon -> FAILED result
  await page.waitForSelector('.result-status', { timeout: 8000 });
  const rec = await page.evaluate(() => localStorage.getItem('records.v1'));
  if (rec === null || !rec.includes('song-19d6fdce::song-19d6fdce-another'))
    throw new Error(`abandoned real play should write playCount for the practice song: ${rec}`);
  await page.screenshot({ path: SHOT('10c-dojo-real') });
  await page.keyboard.press('Escape'); // back to select
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
  await page.keyboard.press('Escape'); // collapse
  await page.keyboard.press('KeyA'); // autoplay back ON — later steps expect it
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  if (!bar.includes('AUTOPLAY ON')) throw new Error(`autoplay restore failed: ${bar}`);
});

// --- Practice mode (practice-mode.md acceptance criteria) ---
let recordsBeforePractice = null;

await step('enter practice editor from select (P) — song-select MUST 10', async () => {
  recordsBeforePractice = await page.evaluate(() => localStorage.getItem('records.v1'));
  await page.keyboard.press('KeyP');
  await page.waitForSelector('[data-screen="PRACTICE_EDIT"].active .practice-grid', {
    timeout: 5000,
  });
  await page.screenshot({ path: SHOT('13-practice-editor') });
});

await step('grid keyboard editing: Space places and removes a note', async () => {
  const meta = () => page.$eval('.practice-meta', (n) => n.textContent);
  await page.keyboard.press('Space');
  if (!(await meta()).includes('1 note(s)')) throw new Error('Space did not place a note');
  await page.keyboard.press('Space');
  if (!(await meta()).includes('0 note(s)')) throw new Error('Space did not remove the note');
});

await step('1 bar + trill preset + 2 target loops', async () => {
  await page.selectOption('label:has-text("BARS") select', '1');
  await page.selectOption('label:has-text("PRESET") select', 'trill');
  await page.click('button:has-text("APPLY PRESET")');
  const meta = await page.$eval('.practice-meta', (n) => n.textContent);
  console.log(`  meta: ${meta}`);
  if (!meta.includes('16 note(s)')) throw new Error(`trill on 1 bar should be 16 notes: ${meta}`);
  await page.fill('label:has-text("LOOPS") input', '2');
});

await step('save pattern to IndexedDB, listed by name', async () => {
  await page.fill('label:has-text("NAME") input', 'E2E Trill');
  await page.click('button:has-text("SAVE")');
  await page.waitForFunction(
    () => document.querySelector('.practice-status')?.textContent?.includes('saved'),
    { timeout: 5000 },
  );
  const list = await page.$eval('.practice-list', (n) => n.textContent);
  console.log(`  saved list: ${list}`);
  if (!list.includes('E2E Trill')) throw new Error('saved pattern missing from list');
});

await step('start practice -> PixiJS canvas, no gauge, mash keys mid-loop', async () => {
  await page.click('button:has-text("START PRACTICE")');
  await page.waitForSelector('[data-screen="PRACTICE_PLAY"].active canvas', { timeout: 20000 });
  await page.waitForTimeout(3500); // lead-in 0.75s + count-in + into loop 1
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('KeyS');
    await page.keyboard.press('KeyD');
    await page.waitForTimeout(120);
  }
  await page.screenshot({ path: SHOT('14-practice-play') });
});

await step('2 loops auto-end -> back on editor with session summary', async () => {
  // 2 cycles of (4+4) beats @120bpm = 8s + lead-in/handoff.
  await page.waitForSelector('[data-screen="PRACTICE_EDIT"].active', { timeout: 20000 });
  const status = await page.$eval('.practice-status', (n) => n.textContent);
  console.log(`  summary: ${status}`);
  if (!status.includes('session complete')) throw new Error('missing auto-end summary');
  if (!status.includes('2 loop(s)')) throw new Error('summary should report 2 loops');
  const canvases = await page.$$('canvas');
  if (canvases.length > 0) throw new Error(`residual canvases after practice: ${canvases.length}`);
  await page.screenshot({ path: SHOT('15-practice-summary') });
});

await step('practice wrote NOTHING to records (acceptance criterion)', async () => {
  const after = await page.evaluate(() => localStorage.getItem('records.v1'));
  if (after !== recordsBeforePractice) throw new Error('practice session modified records.v1');
});

await step('reload -> saved pattern survives (IndexedDB) and loads', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.press-key', { timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  await page.keyboard.press('KeyP');
  await page.waitForSelector('[data-screen="PRACTICE_EDIT"].active .practice-grid', {
    timeout: 5000,
  });
  await page.waitForFunction(
    () => document.querySelector('.practice-list')?.textContent?.includes('E2E Trill'),
    { timeout: 5000 },
  );
  await page.click('.practice-list li:has-text("E2E Trill") button:has-text("LOAD")');
  const meta = await page.$eval('.practice-meta', (n) => n.textContent);
  console.log(`  meta after load: ${meta}`);
  if (!meta.includes('16 note(s)')) throw new Error('loaded pattern should have 16 notes');
});

await step('Escape returns editor -> song select', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-screen="SONG_SELECT"].active .song-list li.selected', {
    timeout: 5000,
  });
});

// --- Settings screen (settings-screen.md acceptance criteria) ---
const settingsValue = (rowKey) =>
  page.$eval(`[data-row="${rowKey}"] .settings-value`, (n) => n.textContent);
const settingsDoc = async () => {
  const raw = await page.evaluate(() => localStorage.getItem('settings.v1'));
  return raw === null ? null : JSON.parse(raw).data;
};

await step('enter settings from select (O) — song-select MUST 10', async () => {
  await page.keyboard.press('KeyO');
  await page.waitForSelector('[data-screen="SETTINGS"].active .settings-list', { timeout: 5000 });
  const scratch = await settingsValue('lane-0');
  if (!scratch.includes('ShiftLeft'))
    throw new Error(`default scratch should be ShiftLeft: ${scratch}`);
  await page.screenshot({ path: SHOT('16-settings') });
});

await step('key capture: conflict + reserved rejected, fresh code assigned', async () => {
  await page.keyboard.press('Enter'); // capture on SCRATCH (focus starts at row 0)
  if (!(await settingsValue('lane-0')).includes('PRESS A KEY'))
    throw new Error('capture mode indicator missing');
  await page.keyboard.press('KeyS'); // KEY 1's binding -> conflict
  const conflictRow = await page.$eval('.settings-row.conflict', (n) => n.dataset.row);
  if (conflictRow !== 'lane-1') throw new Error(`conflict highlight on wrong row: ${conflictRow}`);
  let status = await page.$eval('.settings-status', (n) => n.textContent);
  if (!status.includes('KEY 1')) throw new Error(`conflict notice should name KEY 1: ${status}`);
  await page.keyboard.press('PageUp'); // reserved in-play control
  status = await page.$eval('.settings-status', (n) => n.textContent);
  if (!status.includes('reserved')) throw new Error(`reserved notice missing: ${status}`);
  if (!(await settingsValue('lane-0')).includes('PRESS A KEY'))
    throw new Error('rejections should keep capture mode active');
  await page.keyboard.press('KeyZ'); // fresh -> assigned
  if (!(await settingsValue('lane-0')).includes('KeyZ')) throw new Error('KeyZ not assigned');
  const doc = await settingsDoc();
  if (doc.keyMapLanes[0] !== 'KeyZ') throw new Error('rebind not persisted to settings.v1');
  await page.screenshot({ path: SHOT('17-settings-rebound') });
});

await step('capture Escape cancels without exiting the screen', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  if (!(await settingsValue('lane-0')).includes('KeyZ'))
    throw new Error('Escape during capture should keep the current binding');
  const active = await page.$('[data-screen="SETTINGS"].active');
  if (active === null) throw new Error('Escape during capture must not leave the settings screen');
});

const secondaryValue = () =>
  page.$eval('[data-row="lane-0"] .settings-value-secondary', (n) => n.textContent);

await step(
  'scratch secondary slot: capture/conflict/reserved/clear (input-handling MUST 12-14, settings MUST 15)',
  async () => {
    if (!(await secondaryValue()).includes('2ND: —'))
      throw new Error(`empty secondary slot not shown: ${await secondaryValue()}`);
    await page.keyboard.press('Insert'); // capture into the 2ND slot (focus is on SCRATCH)
    if (!(await secondaryValue()).includes('PRESS A KEY'))
      throw new Error('secondary capture indicator missing');
    await page.keyboard.press('KeyZ'); // the scratch PRIMARY's current code -> conflict
    const conflictRow = await page.$eval('.settings-row.conflict', (n) => n.dataset.row);
    if (conflictRow !== 'lane-0')
      throw new Error(`secondary conflict should highlight lane-0: ${conflictRow}`);
    let status = await page.$eval('.settings-status', (n) => n.textContent);
    if (!status.includes('SCRATCH'))
      throw new Error(`conflict notice should name SCRATCH: ${status}`);
    await page.keyboard.press('PageDown'); // reserved code -> rejected, still capturing
    status = await page.$eval('.settings-status', (n) => n.textContent);
    if (!status.includes('reserved')) throw new Error(`reserved notice missing: ${status}`);
    await page.keyboard.press('ShiftRight'); // fresh -> assigned
    if (!(await secondaryValue()).includes('2ND: ShiftRight'))
      throw new Error(`ShiftRight not assigned to the secondary: ${await secondaryValue()}`);
    let doc = await settingsDoc();
    if (doc.keyMapScratchSecondary !== 'ShiftRight')
      throw new Error(`secondary not persisted: ${doc.keyMapScratchSecondary}`);
    // Duplicate rule works in the other direction too: a PRIMARY capture must
    // reject the code held by the secondary slot.
    await page.keyboard.press('Enter'); // primary capture on SCRATCH
    await page.keyboard.press('ShiftRight');
    status = await page.$eval('.settings-status', (n) => n.textContent);
    if (!status.includes('SCRATCH (2ND)'))
      throw new Error(`primary capture should name the 2ND slot conflict: ${status}`);
    await page.keyboard.press('Escape'); // cancel the capture
    // Shift+Delete clears ONLY the secondary; primary stays KeyZ.
    await page.keyboard.press('Shift+Delete');
    if (!(await secondaryValue()).includes('2ND: —'))
      throw new Error('Shift+Delete should clear the secondary slot');
    doc = await settingsDoc();
    if (doc.keyMapScratchSecondary !== null) throw new Error('cleared secondary not persisted');
    if (doc.keyMapLanes[0] !== 'KeyZ') throw new Error('clearing 2ND must not touch the primary');
    // Re-assign for the reload-persistence assertion below.
    await page.keyboard.press('Insert');
    await page.keyboard.press('ShiftRight');
    await page.screenshot({ path: SHOT('17b-settings-secondary') });
  },
);

await step('offset adjusts via arrows (fine + coarse) and persists', async () => {
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown'); // to GLOBAL OFFSET row
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight'); // +3
  await page.keyboard.press('Shift+ArrowRight'); // +13
  const shown = await settingsValue('offset');
  if (!shown.includes('+13ms')) throw new Error(`offset should read +13ms, got ${shown}`);
  const doc = await settingsDoc();
  if (doc.globalOffsetMs !== 13) throw new Error(`offset not persisted: ${doc.globalOffsetMs}`);
});

await step('music volume steps by 5% and persists', async () => {
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown'); // to MUSIC row
  await page.keyboard.press('ArrowLeft'); // 100% -> 95%
  const shown = await settingsValue('volume-music');
  if (!shown.includes('95%')) throw new Error(`music volume should read 95%, got ${shown}`);
  const doc = await settingsDoc();
  if (doc.volumes.music !== 0.95) throw new Error(`volume not persisted: ${doc.volumes.music}`);
});

let appliedOffset = null;

await step('calibration: cancel leaves offset; apply proposes + persists', async () => {
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown'); // to CALIBRATION row
  await page.keyboard.press('Enter');
  await page.waitForSelector('.settings-modal.visible', { timeout: 5000 });
  await page.keyboard.press('Space'); // one tap, then cancel
  await page.keyboard.press('Escape');
  await page.waitForSelector('.settings-modal.visible', { state: 'hidden', timeout: 5000 });
  let doc = await settingsDoc();
  if (doc.globalOffsetMs !== 13) throw new Error('cancelled calibration must not change offset');
  await page.keyboard.press('Enter'); // reopen
  await page.waitForSelector('.settings-modal.visible', { timeout: 5000 });
  // Taps that predate the first click by over half a period are ignored (the
  // clicks start after a 0.5s lead-in), so wait for them and tap until done.
  await page.waitForTimeout(700);
  let modalText = '';
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(70);
    modalText = await page.$eval('.settings-modal-body', (n) => n.textContent);
    if (modalText.includes('apply as the new global offset')) break;
  }
  console.log(`  proposal: ${modalText}`);
  if (!modalText.includes('apply as the new global offset'))
    throw new Error('proposal not shown after 30 taps');
  await page.keyboard.press('Enter'); // apply
  await page.waitForSelector('.settings-modal.visible', { state: 'hidden', timeout: 5000 });
  doc = await settingsDoc();
  appliedOffset = doc.globalOffsetMs;
  console.log(`  applied offset: ${appliedOffset}`);
  if (!Number.isInteger(appliedOffset) || Math.abs(appliedOffset) > 200)
    throw new Error(`applied offset out of range: ${appliedOffset}`);
  const shown = await settingsValue('offset');
  if (!shown.includes(`${Math.abs(appliedOffset)}ms`))
    throw new Error(`offset row should show the applied value, got ${shown}`);
  await page.screenshot({ path: SHOT('18-settings-calibrated') });
});

await step('Escape exits settings back to select', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-screen="SONG_SELECT"].active .song-list li.selected', {
    timeout: 5000,
  });
});

await step('settings persist across reload (acceptance criterion)', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  await page.keyboard.press('KeyO');
  await page.waitForSelector('[data-screen="SETTINGS"].active', { timeout: 5000 });
  if (!(await settingsValue('lane-0')).includes('KeyZ'))
    throw new Error('rebound key lost on reload');
  if (!(await secondaryValue()).includes('2ND: ShiftRight'))
    throw new Error('scratch secondary lost on reload (input-handling MUST 12 acceptance)');
  const shownOffset = await settingsValue('offset');
  if (!shownOffset.includes(`${Math.abs(appliedOffset)}ms`))
    throw new Error(`offset lost on reload: ${shownOffset} vs ${appliedOffset}`);
  if (!(await settingsValue('volume-music')).includes('95%'))
    throw new Error('music volume lost on reload');
});

await step('reset-all restores default key map (secondary cleared too)', async () => {
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown'); // to ALL KEYS row
  await page.keyboard.press('Enter');
  if (!(await settingsValue('lane-0')).includes('ShiftLeft'))
    throw new Error('reset-all did not restore scratch default');
  if (!(await secondaryValue()).includes('2ND: —'))
    throw new Error('reset-all should clear the scratch secondary (MUST 12: default unbound)');
  const doc = await settingsDoc();
  if (doc.keyMapLanes.join(',') !== 'ShiftLeft,KeyS,KeyD,KeyF,Space,KeyJ,KeyK,KeyL')
    throw new Error(`reset-all not persisted: ${doc.keyMapLanes}`);
  if (doc.keyMapScratchSecondary !== null)
    throw new Error(`reset-all should persist a null secondary: ${doc.keyMapScratchSecondary}`);
});

await step('corrupt settings.v1 falls back to defaults without crashing', async () => {
  await page.evaluate(() => localStorage.setItem('settings.v1', '{broken json!!'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  await page.keyboard.press('KeyO');
  await page.waitForSelector('[data-screen="SETTINGS"].active', { timeout: 5000 });
  if (!(await settingsValue('lane-0')).includes('ShiftLeft'))
    throw new Error('corrupt doc should fall back to default key map');
  if (!(await settingsValue('offset')).includes('+0ms'))
    throw new Error('corrupt doc should fall back to +0ms offset');
  await page.keyboard.press('Escape'); // leave the app on select
  await page.waitForSelector('[data-screen="SONG_SELECT"].active', { timeout: 5000 });
  await page.screenshot({ path: SHOT('19-settings-defaults') });
});

await step(
  'in-play: secondary scratch keydown fires while the primary is held (MUST 13 acceptance)',
  async () => {
    // Bind a secondary on the (post-corruption default) map, then play manually.
    await page.keyboard.press('KeyO');
    await page.waitForSelector('[data-screen="SETTINGS"].active', { timeout: 5000 });
    await page.keyboard.press('Insert');
    await page.keyboard.press('ShiftRight');
    if (!(await secondaryValue()).includes('2ND: ShiftRight'))
      throw new Error('secondary not bound for the in-play check');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-screen="SONG_SELECT"].active .song-list li.selected', {
      timeout: 5000,
    });
    await page.keyboard.press('KeyA'); // autoplay OFF — real keys must judge
    const bar = await page.$eval('.options-bar', (n) => n.textContent);
    if (!bar.includes('AUTOPLAY OFF')) throw new Error('autoplay should be OFF for manual input');
    await navigateToSong('First Light');
    await page.keyboard.press('Enter'); // expand
    await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
    await page.keyboard.press('Enter'); // play
    await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
    await page.keyboard.press('F1'); // dev overlay: AVG (n) counts real keydown samples
    await page.waitForTimeout(800);
    // Hold the primary, tap the secondary while it is held, then release both.
    // Two independent keydowns ⇒ exactly two input-latency samples: the per-lane
    // held-guard of the single-key design would have swallowed the second one.
    await page.keyboard.down('ShiftLeft');
    await page.waitForTimeout(120);
    await page.keyboard.down('ShiftRight');
    await page.waitForTimeout(120);
    await page.keyboard.up('ShiftRight');
    await page.keyboard.up('ShiftLeft');
    await page.waitForFunction(
      () => {
        const text = document.querySelector('[data-screen="PLAY"]')?.dataset?.devOverlay ?? '';
        return / \(2\)/.test(text);
      },
      { timeout: 5000 },
    );
    await page.keyboard.press('F1');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.result-status', { timeout: 8000 });
    await page.keyboard.press('Escape'); // back to select
    await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
  },
);

await step('gauge-out death: freeze + fade before FAILED results (SHOULD 15)', async () => {
  // Autoplay is OFF from the previous step; First Light stays expanded, so
  // KeyG (NORMAL -> HARD) then Enter starts a play nobody touches — 12 misses
  // at HARD's −10%/−5% drain the survival gauge well before the song ends.
  await page.keyboard.press('KeyG');
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  if (!bar.includes('HARD')) throw new Error(`gauge should cycle to HARD: ${bar}`);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  // The controller mirrors the freeze onto data-death the frame the gauge dies
  // (canvas pixels are unreadable here — same pattern as data-timing).
  await page.waitForSelector('[data-screen="PLAY"][data-death]', { timeout: 40000 });
  const deathAt = Date.now();
  await page.screenshot({ path: SHOT('19-death-freeze') });
  await page.waitForSelector('.result-status', { timeout: 8000 });
  const holdMs = Date.now() - deathAt;
  console.log(`  death -> results hold: ${holdMs}ms`);
  // DEATH_HOLD_MS is 1000: the freeze+fade must actually play out (>600ms even
  // with polling slack) but never stall the transition (<4s).
  if (holdMs < 600 || holdMs > 4000)
    throw new Error(`death hold outside the freeze+fade window: ${holdMs}ms`);
  const status = await page.$eval('.result-status', (n) => n.textContent);
  const sub = await page.$eval('.result-sub', (n) => n.textContent);
  console.log(`  results: ${status} | ${sub}`);
  if (status !== 'FAILED') throw new Error(`gauge-out should FAIL: ${status}`);
  if (!sub.includes('HARD GAUGE') || !sub.includes('died at'))
    throw new Error(`missing gauge-death markers on results sub-line: ${sub}`);
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  if (!grid.includes('GAUGE0.0%')) throw new Error(`final gauge should read 0.0%: ${grid}`);
  await page.screenshot({ path: SHOT('19-death-results') });
  // Restore NORMAL gauge (HARD -> EX_HARD -> ASSIST_EASY -> EASY -> NORMAL).
  await page.keyboard.press('Escape');
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
  for (let i = 0; i < 4; i++) await page.keyboard.press('KeyG');
  const restored = await page.$eval('.options-bar', (n) => n.textContent);
  if (!restored.includes('NORMAL')) throw new Error(`gauge not restored: ${restored}`);
});

console.log('--- console messages (last 25) ---');
for (const m of consoleMsgs.slice(-25)) console.log(m);
console.log('--- errors ---');
for (const e of errors) console.log(e);
console.log(errors.length === 0 ? 'NO PAGE ERRORS' : `ERRORS: ${errors.length}`);
await browser.close();
process.exit(errors.length === 0 ? 0 : 2);
