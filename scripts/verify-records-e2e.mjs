// Milestone 3 records-flow verification: asserts the actual localStorage
// records.v1 document (playCount / lamp / bests / autoplay-skip / persistence)
// on top of what scripts/verify-e2e.mjs already covers at the DOM level.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173/';
const errors = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`STEP OK: ${name}`);
  } catch (e) {
    console.log(`STEP FAIL: ${name}: ${e.message}`);
    await page.screenshot({ path: '/tmp/iidx-records-fail.png' }).catch(() => {});
    await browser.close();
    process.exit(1);
  }
};

const readRecordsDoc = () =>
  page.evaluate(() => {
    const raw = localStorage.getItem('records.v1');
    return raw === null ? null : JSON.parse(raw);
  });

const soleEntry = (doc) => {
  const entries = Object.values(doc.data.records);
  if (entries.length !== 1) throw new Error(`expected 1 record entry, got ${entries.length}`);
  return entries[0];
};

const abandonPlay = async () => {
  await page.waitForSelector('.screen-play canvas', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.result-status', { timeout: 8000 });
};

await step('load + unlock + fresh storage', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.waitForSelector('.press-key', { timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  if ((await readRecordsDoc()) !== null) throw new Error('records.v1 should not exist yet');
});

await step('real play abandon writes FAILED record, no bests', async () => {
  await page.keyboard.press('Enter'); // enter PLAY
  await abandonPlay();
  const doc = await readRecordsDoc();
  if (doc === null) throw new Error('records.v1 missing after abandoned play');
  if (doc.version !== 1) throw new Error(`envelope version ${doc.version}`);
  const e = soleEntry(doc);
  console.log('  entry:', JSON.stringify(e));
  if (e.playCount !== 1) throw new Error(`playCount ${e.playCount}`);
  if (e.clearLamp !== 'FAILED') throw new Error(`clearLamp ${e.clearLamp}`);
  if (e.bestExScore !== null || e.bestRank !== null || e.minBP !== null)
    throw new Error('abandoned play must not set bests');
  if (!e.songId || !e.chartId) throw new Error('entry missing songId/chartId');
  if (!/\d{4}-\d{2}-\d{2}T/.test(e.lastPlayedAt)) throw new Error('lastPlayedAt not ISO');
});

await step('results DOM shows NEW RECORD lamp badge + FIRST PLAY', async () => {
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  if (!grid.includes('NEW RECORD')) throw new Error('missing NEW RECORD badge');
  if (!grid.includes('FIRST PLAY')) throw new Error('missing FIRST PLAY note');
});

await step('retry abandon: playCount=2, no lamp badge (FAILED again)', async () => {
  await page.keyboard.press('Enter'); // retry
  await abandonPlay();
  const e = soleEntry(await readRecordsDoc());
  if (e.playCount !== 2) throw new Error(`playCount ${e.playCount}`);
  if (e.clearLamp !== 'FAILED') throw new Error(`clearLamp ${e.clearLamp}`);
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  if (grid.includes('NEW RECORD')) throw new Error('FAILED->FAILED must not badge NEW RECORD');
});

await step('autoplay abandon writes nothing', async () => {
  await page.keyboard.press('Escape'); // back to select
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  await page.keyboard.press('KeyA'); // autoplay ON
  await page.keyboard.press('Enter');
  await abandonPlay();
  const e = soleEntry(await readRecordsDoc());
  if (e.playCount !== 2) throw new Error(`autoplay changed playCount to ${e.playCount}`);
  const grid = await page.$eval('.result-grid', (n) => n.textContent);
  if (grid.includes('NEW RECORD') || grid.includes('FIRST PLAY'))
    throw new Error('autoplay results must carry no record markers');
});

await step('record persists across reload', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const e = soleEntry(await readRecordsDoc());
  if (e.playCount !== 2 || e.clearLamp !== 'FAILED') throw new Error('record lost on reload');
});

await step('corrupt records.v1 -> backup + confirm prompt, no crash', async () => {
  await page.evaluate(() => localStorage.setItem('records.v1', '{not json'));
  let confirmMsg = null;
  page.once('dialog', (d) => {
    confirmMsg = d.message();
    d.accept();
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.press-key', { timeout: 5000 });
  const { backup, reset } = await page.evaluate(() => ({
    backup: localStorage.getItem('records.v1.corrupt'),
    reset: localStorage.getItem('records.v1'),
  }));
  console.log('  confirm:', JSON.stringify(confirmMsg));
  if (backup !== '{not json') throw new Error('corrupt raw not backed up');
  if (confirmMsg === null) throw new Error('no reset confirm prompt shown');
  if (JSON.parse(reset).version !== 1) throw new Error('accepted reset did not rewrite doc');
});

await browser.close();
if (errors.length) {
  console.log('--- errors ---');
  for (const e of errors) console.log(e);
  process.exit(1);
}
console.log('RECORDS E2E: ALL PASS, NO PAGE ERRORS');
