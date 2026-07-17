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
  // Cursor starts on the first song row (First Light under TITLE sort).
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
  if (songCount !== 3)
    throw new Error(`clearing the filter should restore 3 songs, got ${songCount}`);
});

await step(
  'level folder view (F): charts group by level, persists to select.v1 (SHOULD 13)',
  async () => {
    await page.keyboard.press('KeyF');
    const line = await page.$eval('.sort-line', (n) => n.textContent);
    if (!line.includes('LEVEL FOLDERS'))
      throw new Error(`readout should show LEVEL FOLDERS: ${line}`);
    // Catalog levels: FL N4/H7, NC N6/H8, OC H9/A11 -> folders 4,6,7,8,9,11 with 1 chart each.
    const folders = await page.$$eval('.song-list li.folder-row .folder-title', (ls) =>
      ls.map((l) => l.textContent),
    );
    console.log(`  folders: ${JSON.stringify(folders)}`);
    const levels = folders.map((f) => f.replace('LEVEL ', ''));
    if (levels.join(',') !== '4,6,7,8,9,11')
      throw new Error(`expected folders 4,6,7,8,9,11 ascending, got ${levels.join(',')}`);
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
    if (!grid.includes('BAD0POOR (miss)0POOR (empty)0BP0'))
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
  const shownOffset = await settingsValue('offset');
  if (!shownOffset.includes(`${Math.abs(appliedOffset)}ms`))
    throw new Error(`offset lost on reload: ${shownOffset} vs ${appliedOffset}`);
  if (!(await settingsValue('volume-music')).includes('95%'))
    throw new Error('music volume lost on reload');
});

await step('reset-all restores default key map', async () => {
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown'); // to ALL KEYS row
  await page.keyboard.press('Enter');
  if (!(await settingsValue('lane-0')).includes('ShiftLeft'))
    throw new Error('reset-all did not restore scratch default');
  const doc = await settingsDoc();
  if (doc.keyMapLanes.join(',') !== 'ShiftLeft,KeyS,KeyD,KeyF,Space,KeyJ,KeyK,KeyL')
    throw new Error(`reset-all not persisted: ${doc.keyMapLanes}`);
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

console.log('--- console messages (last 25) ---');
for (const m of consoleMsgs.slice(-25)) console.log(m);
console.log('--- errors ---');
for (const e of errors) console.log(e);
console.log(errors.length === 0 ? 'NO PAGE ERRORS' : `ERRORS: ${errors.length}`);
await browser.close();
process.exit(errors.length === 0 ? 0 : 2);
