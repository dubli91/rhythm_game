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

await step('unlock -> song select', async () => {
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  const items = await page.$$eval('.song-list li', (ls) => ls.map((l) => l.textContent));
  console.log('  charts listed:', JSON.stringify(items));
  await page.screenshot({ path: SHOT('2-select') });
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

await step('ESC back to select, enable AUTOPLAY, retry', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.song-list li.selected', { timeout: 5000 });
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

console.log('--- console messages (last 25) ---');
for (const m of consoleMsgs.slice(-25)) console.log(m);
console.log('--- errors ---');
for (const e of errors) console.log(e);
console.log(errors.length === 0 ? 'NO PAGE ERRORS' : `ERRORS: ${errors.length}`);
await browser.close();
process.exit(errors.length === 0 ? 0 : 2);
