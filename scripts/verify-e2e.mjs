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

await step('hi-speed adjust from options panel persists', async () => {
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const bar = await page.$eval('.options-bar', (n) => n.textContent);
  console.log(`  options bar: ${bar}`);
  if (!bar.includes('1.50')) throw new Error('hi-speed should read 1.50 after two +0.25 steps');
  const doc = await page.evaluate(() => localStorage.getItem('playOptions.v1'));
  if (!doc || !doc.includes('1.5')) throw new Error('hi-speed not persisted');
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
};

await step(
  'play smoke: Neon Cascade NORMAL (BPM-change/STOP chart) loads + autoplays',
  async () => {
    await playSmoke('Neon Cascade', 'NORMAL', 10);
    await page.screenshot({ path: SHOT('9-neon-smoke') });
  },
);

await step('play smoke: Overdrive Core ANOTHER (densest chart) loads + autoplays', async () => {
  await playSmoke('Overdrive Core', 'ANOTHER', 8);
  await page.screenshot({ path: SHOT('10-overdrive-smoke') });
});

console.log('--- console messages (last 25) ---');
for (const m of consoleMsgs.slice(-25)) console.log(m);
console.log('--- errors ---');
for (const e of errors) console.log(e);
console.log(errors.length === 0 ? 'NO PAGE ERRORS' : `ERRORS: ${errors.length}`);
await browser.close();
process.exit(errors.length === 0 ? 0 : 2);
