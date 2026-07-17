// Milestone 3 records-flow verification: asserts the actual localStorage
// records.v1 document (playCount / lamp / bests / autoplay-skip / persistence)
// on top of what scripts/verify-e2e.mjs already covers at the DOM level.
// Milestone 7 extended it with the records export/import round-trip and the
// player-statistics modal (results-records.md SHOULD 10/11).
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173/';
const errors = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, acceptDownloads: true });
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

// The grouped select list shows song rows first; Enter on a song row only
// expands it. Move the cursor to the requested song row before expanding.
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

await step('load + unlock + fresh storage', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.waitForSelector('.press-key', { timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  if ((await readRecordsDoc()) !== null) throw new Error('records.v1 should not exist yet');
});

await step('real play abandon writes FAILED record, no bests', async () => {
  await navigateToSong('First Light');
  await page.keyboard.press('Enter'); // expand -> NORMAL chart row auto-selected
  await page.waitForSelector('.song-list li.chart-row', { timeout: 5000 });
  const selected = await page.$eval('.song-list li.selected', (n) => n.textContent);
  if (!selected.includes('NORMAL')) throw new Error('expected NORMAL chart selected after expand');
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
  // Pin the exact chart: a wrong-song/wrong-chart record would otherwise pass silently.
  if (e.songId !== 'song-6f90aea6') throw new Error(`songId ${e.songId}, expected First Light`);
  if (e.chartId !== 'song-6f90aea6-normal') throw new Error(`chartId ${e.chartId}`);
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

// --- records export/import + statistics (results-records.md SHOULD 10/11) ---

let exportedPath = null;
let exportedEntry = null;

await step('seed one FAILED record for the export flow', async () => {
  // The corrupt-reset step above left an accepted, empty records doc at TITLE.
  await page.keyboard.press('Enter');
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  await page.keyboard.press('KeyA'); // autoplay was left ON by the autoplay step; turn it OFF
  await navigateToSong('First Light');
  await page.keyboard.press('Enter'); // expand
  await page.keyboard.press('Enter'); // play NORMAL
  await abandonPlay();
  await page.keyboard.press('Escape'); // back to select
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  exportedEntry = soleEntry(await readRecordsDoc());
  if (exportedEntry.clearLamp !== 'FAILED') throw new Error(`lamp ${exportedEntry.clearLamp}`);
});

await step('settings stats modal aggregates records', async () => {
  await page.keyboard.press('KeyO'); // settings entry
  await page.waitForSelector('[data-screen="SETTINGS"].active', { timeout: 5000 });
  const summary = await page.$eval(
    '.settings-section:has(+ [data-row="stats"]) .settings-summary',
    (n) => n.textContent,
  );
  console.log('  records summary:', JSON.stringify(summary));
  if (!summary.includes('1 plays')) throw new Error(`summary "${summary}"`);
  await page.click('[data-row="stats"] button');
  await page.waitForSelector('[data-modal="stats"].visible', { timeout: 5000 });
  const body = await page.$eval('[data-modal="stats"]', (n) => n.textContent);
  if (!body.includes('1 PLAYS')) throw new Error('total plays missing');
  if (!body.includes('charts played')) throw new Error('played/total line missing');
  if (!body.includes('FAILED')) throw new Error('lamp distribution missing FAILED');
  if (!body.includes('☆')) throw new Error('clear-by-level rows missing');
  await page.keyboard.press('Escape');
  const stillOpen = await page.$('[data-modal="stats"].visible');
  if (stillOpen !== null) throw new Error('Escape did not close the stats modal');
});

await step('export downloads the records.v1 envelope', async () => {
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await page.click('[data-row="exportRecords"] button');
  const download = await downloadPromise;
  if (!/^iidx-web-records-.*\.json$/.test(download.suggestedFilename()))
    throw new Error(`filename ${download.suggestedFilename()}`);
  exportedPath = await download.path();
  const exported = JSON.parse(await readFile(exportedPath, 'utf8'));
  const stored = await readRecordsDoc();
  if (JSON.stringify(exported) !== JSON.stringify(stored))
    throw new Error('exported JSON does not match stored records.v1');
  const status = await page.$eval('.settings-status', (n) => n.textContent);
  if (!status.includes('exported')) throw new Error(`status "${status}"`);
});

await step('import into a reset browser fully restores records', async () => {
  await page.evaluate(() => localStorage.removeItem('records.v1'));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.keyboard.press('Enter'); // unlock -> select
  await page.waitForSelector('.song-list li.selected', { timeout: 8000 });
  if ((await readRecordsDoc()) !== null) throw new Error('records.v1 should be gone');
  await page.keyboard.press('KeyO');
  await page.waitForSelector('[data-screen="SETTINGS"].active', { timeout: 5000 });
  await page.setInputFiles('[data-role="import-records"]', exportedPath);
  await page.waitForFunction(
    () => document.querySelector('.settings-status')?.textContent.includes('import complete'),
    { timeout: 5000 },
  );
  const status = await page.$eval('.settings-status', (n) => n.textContent);
  console.log('  status:', JSON.stringify(status));
  if (!status.includes('1 added')) throw new Error(`status "${status}"`);
  const restored = soleEntry(await readRecordsDoc());
  if (JSON.stringify(restored) !== JSON.stringify(exportedEntry))
    throw new Error('restored record differs from the exported one');
});

await step('re-import of the same file is idempotent (stored bytes identical)', async () => {
  const before = await page.evaluate(() => localStorage.getItem('records.v1'));
  await page.setInputFiles('[data-role="import-records"]', exportedPath);
  await page.waitForFunction(
    () => document.querySelector('.settings-status')?.textContent.includes('1 unchanged'),
    { timeout: 5000 },
  );
  const after = await page.evaluate(() => localStorage.getItem('records.v1'));
  if (after !== before) throw new Error('idempotent re-import mutated stored bytes');
});

await step('invalid import file is rejected without touching records', async () => {
  const badPath = '/tmp/iidx-bad-import.json';
  await writeFile(badPath, '{"version":9,"data":{"records":{}}}');
  const before = await page.evaluate(() => localStorage.getItem('records.v1'));
  await page.setInputFiles('[data-role="import-records"]', badPath);
  await page.waitForFunction(
    () => document.querySelector('.settings-status')?.textContent.includes('import failed'),
    { timeout: 5000 },
  );
  const after = await page.evaluate(() => localStorage.getItem('records.v1'));
  if (after !== before) throw new Error('failed import must not touch records');
});

await step('imported lamp shows on song select', async () => {
  await page.keyboard.press('Escape'); // settings -> select
  await page.waitForSelector('[data-screen="SONG_SELECT"].active', { timeout: 5000 });
  await navigateToSong('First Light');
  await page.keyboard.press('Enter'); // expand
  await page.waitForSelector('.song-list li.chart-row .lamp-FAILED', { timeout: 5000 });
});

await browser.close();
if (errors.length) {
  console.log('--- errors ---');
  for (const e of errors) console.log(e);
  process.exit(1);
}
console.log('RECORDS E2E: ALL PASS, NO PAGE ERRORS');
