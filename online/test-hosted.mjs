import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:4173';
const call = async (route, method = 'GET', body, extra = {}) => {
  const result = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Connection: 'close', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await result.json();
  return { status: result.status, data };
};
const initial = await call('/api/leads');
assert.equal(initial.status, 200);
assert.equal(initial.data.leads.length, 0, 'Use an empty isolated preview DB for this test.');
const config = await call('/api/config');
assert.equal(config.data.model, 'gemini-3.5-flash-lite');
assert.ok(Object.hasOwn(config.data.keys, 'GEMINI_API_KEY'));
assert.ok(!Object.hasOwn(config.data.keys, 'ANTHROPIC_API_KEY'));
const blocked = await call('/api/leads', 'POST', {}, { Origin: 'https://unrelated.example' });
assert.equal(blocked.status, 403);
const created = await call('/api/leads', 'POST', { name: 'Hosted QA channel', type: 'video', source: 'QA fixture', link: 'https://youtube.com/channel/hosted-qa' });
assert.equal(created.status, 201);
const id = created.data.id;
const message = 'Salam, "QA"!\nAik short sample edit bhejoon?';
assert.equal((await call(`/api/leads/${id}`, 'PATCH', { message, notes: 'First, "note"\nSecond line', status: 'sent' })).status, 200);
const reread = await call('/api/leads');
assert.equal(reread.data.leads[0].message, message);
assert.equal(reread.data.leads[0].wa_link, '');
assert.ok(reread.data.leads[0].followup_date);
const duplicate = await call('/api/leads', 'POST', { name: 'Duplicate QA', type: 'video', link: 'http://www.youtube.com/channel/hosted-qa/about' });
assert.equal(duplicate.status, 409);
const csv = await (await fetch(base + '/api/export')).text();
assert.match(csv, /""QA""/);
assert.equal((await call('/api/import', 'POST', { csv })).data.skipped, 1);
await call('/api/settings', 'POST', { SENDER_NAME: 'QA Sender', PORTFOLIO_URL: 'https://example.com/portfolio' });
assert.equal((await call('/api/config')).data.sender_name, 'QA Sender');

await fs.mkdir('.qa', { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await context.route('https://fonts.gstatic.com/**', (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lead-row');
  await page.click('.lead-row');
  assert.match(await page.locator('#draft-button').textContent(), /Gemini/);
  assert.equal(await page.inputValue('#detail-message'), message);
  await page.fill('#detail-notes', 'Browser saves, with "quotes".\nAnd another line.');
  await page.selectOption('#detail-status', 'replied');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'All changes saved');
  assert.equal(await page.inputValue('#detail-followup'), '');
  await page.click('#detail-close');
  await page.reload();
  await page.waitForSelector('.lead-row');
  assert.equal(await page.locator('#count-replied').textContent(), '1');
  await page.click('#settings-open');
  assert.equal(await page.locator('[name=GEMINI_API_KEY]').getAttribute('type'), 'password');
  assert.equal(await page.locator('a[href="https://aistudio.google.com/apikey"]').count(), 1);
  await page.waitForSelector('#backup-list a');
  await page.fill('#settings-sender', 'Updated sender');
  await page.click('#settings-submit');
  await page.waitForFunction(() => document.getElementById('toast').textContent === 'Settings saved.');
  assert.equal((await call('/api/config')).data.sender_name, 'Updated sender');
  await page.click('#settings-close');
  // Compare to the requested width: mobile browsers can enlarge innerWidth when content overflows.
  const assertFits = async (width, label) => {
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[open]');
      return { page: document.documentElement.scrollWidth, dialogWidth: dialog?.clientWidth, dialogScroll: dialog?.scrollWidth, right: dialog?.getBoundingClientRect().right };
    });
    assert.ok(layout.page <= width, `${label} exceeds ${width}px: ${JSON.stringify(layout)}`);
    if (layout.dialogWidth) {
      assert.ok(layout.dialogScroll <= layout.dialogWidth, `${label} has horizontal dialog overflow at ${width}px`);
      assert.ok(layout.right <= width, `${label} extends off screen at ${width}px`);
    }
  };
  for (const width of [320, 344, 360, 375, 390, 412, 430, 600, 700, 701, 768, 820, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await assertFits(width, 'Dashboard');
    await page.click('#add-open'); await assertFits(width, 'Add lead'); await page.click('#add-close');
    await page.click('#settings-open'); await assertFits(width, 'Settings'); await page.click('#settings-close');
    await page.locator('.lead-row').first().click(); await assertFits(width, 'Lead details'); await page.click('#detail-close');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.click('.lead-row');
  const bounds = await page.locator('#detail-dialog').boundingBox();
  assert.equal(Math.round(bounds.width), 390); assert.equal(Math.round(bounds.height), 844);
  await page.click('#delete-lead'); await page.click('#delete-confirm');
  await page.waitForSelector('#detail-dialog', { state: 'hidden' });
  assert.equal((await call('/api/leads')).data.leads.length, 0);
  await page.screenshot({ path: '.qa/online-phone.png', fullPage: true });
  assert.deepEqual(errors, []);
} finally { await browser.close(); }

for (let i = 0; i < 25; i++) {
  const lead = await call('/api/leads', 'POST', { name: `Revision QA ${i}`, type: 'web', phone: '+923001234567' });
  await call(`/api/leads/${lead.data.id}`, 'DELETE');
}
const backups = await call('/api/backups');
assert.equal(backups.data.backups.length, 20);
const backup = await fetch(base + '/api/backups/' + backups.data.backups[0].revision + '.csv');
assert.equal(backup.status, 200); assert.match(backup.headers.get('content-type'), /text\/csv/);
const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) => call('/api/leads', 'POST', { name: `Concurrent QA ${i}`, type: 'web', phone: '+923001234567' })));
assert.ok(concurrent.every((result) => result.status === 201));
assert.equal((await call('/api/leads')).data.leads.length, 6);
for (const result of concurrent) await call(`/api/leads/${result.data.id}`, 'DELETE');
await call('/api/settings', 'POST', { SENDER_NAME: '', PORTFOLIO_URL: '' });
assert.equal((await call('/api/leads')).data.leads.length, 0);
process.stdout.write('Hosted preview checks passed: durable CSV, quoted multiline fields, duplicates, import/export, concurrent writes, 20 backups, encrypted settings, autosave, reload, sent/replied dates, delete and phone layout. No provider API calls.\n');
