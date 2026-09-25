#!/usr/bin/env node
/*
 * THoldem end-to-end smoke test (Playwright, plain node script).
 *
 *   PORT=8091 node server.js &          # serve the app
 *   node tests/e2e/smoke.e2e.js          # BASE_URL defaults to http://localhost:8091
 *
 * Env: ONLY=<regex on suite function name, e.g. Edge|Mobile>, BASE_URL, PW_PATH (path to the playwright module), SHOTS (screenshot dir),
 *      HEADFUL=1 to watch it run.
 * Prints PASS/FAIL per check; exits 1 if anything failed.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let playwright;
try { playwright = require(process.env.PW_PATH || 'playwright'); } catch (e) {
  playwright = require('/opt/node22/lib/node_modules/playwright');
}
const { chromium } = playwright;

const BASE = process.env.BASE_URL || 'http://localhost:8091';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'tholdem-e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ harness

const results = [];
let section = '';

class AssertionError extends Error {}
function assert(cond, msg) { if (!cond) throw new AssertionError(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionError(`${msg || 'not equal'}: expected ${b}, got ${a}`);
}
function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) throw new AssertionError(`${msg || 'not near'}: expected ${expected}±${tol}, got ${actual}`);
}

async function check(name, fn) {
  const label = section ? `[${section}] ${name}` : name;
  try {
    await fn();
    results.push({ ok: true, label });
    console.log(`PASS  ${label}`);
  } catch (e) {
    results.push({ ok: false, label, err: e });
    try {
      const pg = pages[pages.length - 1];
      if (pg && !pg.isClosed()) await pg.screenshot({ path: path.join(SHOTS, 'FAIL-' + label.replace(/[^\w]+/g, '_').slice(0, 80) + '.png') });
    } catch (_) { /* ignore */ }
    console.log(`FAIL  ${label}\n      -> ${String(e && e.message || e).split('\n')[0]}`);
  }
}

let browser;
const pages = [];

async function openApp(opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    acceptDownloads: true,
    hasTouch: !!opts.touch,
    isMobile: !!opts.mobile,
  });
  // Google Fonts can't be reached from the sandbox: fail fast instead of waiting.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (err) => page.errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = (msg.location() && msg.location().url) || '';
    const text = msg.text();
    if (/fonts\.(googleapis|gstatic)/.test(loc + text) || /ERR_CERT|ERR_FAILED/.test(text)) return;
    page.errors.push('console: ' + text);
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__tholdem && window.__tholdem.state);
  // Run mode is the default; most suites exercise hand tracking, so switch to Full unless asked not to.
  if (opts.mode !== 'run') await page.evaluate(() => window.__tholdem.setMode('full'));
  if (opts.seed) {
    await page.evaluate(opts.seed);
  }
  pages.push(page);
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__tholdem.state)));
// textContent (not innerText) so CSS text-transform doesn't change what we compare.
const text = (page, sel) => page.locator(sel).first().evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
const visible = (page, sel) => page.locator(sel).first().isVisible();
const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** Fast-forward so `ms` remain in the current level (running or paused), then let a tick run. */
async function ff(page, ms) {
  await page.evaluate((ms) => {
    const c = window.__tholdem.state.clock;
    if (c.running) c.endsAt = Date.now() + ms;
    else c.remainingMs = ms;
    window.__tholdem.tick();
  }, ms);
  await sleep(300);
}

async function blurAll(page) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
}

async function dismissOverlay(page) {
  if (await visible(page, '#overlay')) await page.click('#overlay');
}

async function dismissToast(page) {
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
}

async function tab(page, view) {
  await dismissOverlay(page);
  await page.click(`.tab[data-view="${view}"]`);
}

async function setInput(page, sel, value) {
  const loc = page.locator(sel).first();
  await loc.fill(String(value));
  await loc.dispatchEvent('change');
}

async function chipTotal(page) {
  return page.evaluate(() => {
    const g = window.__tholdem.state.game;
    return g.players.reduce((s, p) => s + p.stack + p.bet, 0) + g.pot;
  });
}

/** Tap a seat once (select it, or toggle it in award mode). */
async function clickSeat(page, seat) {
  await dismissToast(page);
  const id = await page.evaluate((seat) => window.__tholdem.state.game.players.find((p) => p.seat === seat).id, seat);
  await page.click(`.seat[data-id="${id}"] .seat-card`);
  return id;
}

/** Make `seat` the selected player (a second tap on a selected seat opens its menu, so only tap if needed). */
async function selectSeat(page, seat) {
  if ((await selectedSeat(page)) === seat) return;
  await clickSeat(page, seat);
  eq(await selectedSeat(page), seat, 'seat selected');
}

/** Open the player dialog for `seat` (select, then tap again). */
async function openSeatMenu(page, seat) {
  const out = await page.evaluate((seat) => window.__tholdem.state.game.players.find((p) => p.seat === seat).out, seat);
  if (!out) await selectSeat(page, seat);
  await clickSeat(page, seat);
  await page.waitForSelector('#modal:not([hidden])', { timeout: 3000 });
}

async function selectedSeat(page) {
  return page.evaluate(() => {
    const id = window.__tholdem.ui.selected;
    const p = window.__tholdem.state.game.players.find((x) => x.id === id);
    return p ? p.seat : null;
  });
}

async function btn(page, sel) {
  await dismissToast(page);
  await page.click(sel);
}

function noErrors(page) {
  assert(page.errors.length === 0, 'JS errors: ' + page.errors.join(' | '));
}

// ------------------------------------------------------------------ tests

async function testLoadAndClock() {
  section = 'clock';
  const page = await openApp();

  await check('page loads without JS errors', async () => {
    await sleep(500);
    noErrors(page);
    eq(await page.title().then((t) => /THoldem/.test(t)), true, 'title mentions THoldem');
  });

  await check('default table renders 8 seats and 15:00 clock', async () => {
    eq(await page.locator('.seat').count(), 8, 'seat count');
    eq(await text(page, '#clockTime'), '15:00', 'clock');
    const st = await S(page);
    eq(await text(page, '#blindsNow'), `${fmt(st.config.levels[0].sb)} / ${fmt(st.config.levels[0].bb)}`, 'side panel blinds');
  });

  await check('Start button starts the clock and time counts down', async () => {
    await page.click('#playPause');
    await sleep(1300);
    const st = await S(page);
    eq(st.clock.running, true, 'running');
    assert((await text(page, '#playPause')).includes('Pause'), 'button shows Pause');
    const t = await text(page, '#clockTime');
    assert(t === '14:59' || t === '14:58', 'clock counted down, got ' + t);
  });

  await check('Pause button freezes the clock', async () => {
    await page.click('#playPause');
    const t1 = await text(page, '#clockTime');
    await sleep(1200);
    eq(await text(page, '#clockTime'), t1, 'frozen');
    eq((await S(page)).clock.running, false, 'paused');
    eq(await text(page, '#clockState'), 'Paused', 'state label');
  });

  await check('Space key starts and pauses', async () => {
    await blurAll(page);
    await page.keyboard.press('Space');
    eq((await S(page)).clock.running, true, 'running after Space');
    await page.keyboard.press('Space');
    eq((await S(page)).clock.running, false, 'paused after 2nd Space');
  });

  await check('Space after clicking Start (button still focused) toggles exactly once', async () => {
    await page.click('#playPause'); // start, focus stays on the button
    eq((await S(page)).clock.running, true, 'running');
    await page.keyboard.press('Space');
    await sleep(100);
    eq((await S(page)).clock.running, false, 'one Space press should pause (not pause+restart)');
    await blurAll(page);
  });

  await check('+1:00 / −1:00 buttons and ↑/↓ keys adjust remaining time', async () => {
    await ff(page, 10 * 60000);
    await page.click('#plusMin');
    eq(await text(page, '#clockTime'), '11:00', '+1:00');
    await page.click('#minusMin');
    await page.click('#minusMin');
    eq(await text(page, '#clockTime'), '9:00', '−1:00 ×2');
    await blurAll(page);
    await page.keyboard.press('ArrowUp');
    eq(await text(page, '#clockTime'), '10:00', 'ArrowUp');
    await page.keyboard.press('ArrowDown');
    eq(await text(page, '#clockTime'), '9:00', 'ArrowDown');
  });

  await check('5-minute warning banner appears and names the next blinds', async () => {
    await page.click('#playPause');
    await blurAll(page);
    await ff(page, 4 * 60000 + 50000);
    assert(await visible(page, '#warningBanner'), 'banner visible');
    const st = await S(page);
    const next = st.config.levels[1];
    const t = await text(page, '#warningText');
    assert(/blinds go up/i.test(t), 'banner text: ' + t);
    assert(t.includes(`${fmt(next.sb)} / ${fmt(next.bb)}`), 'mentions next blinds: ' + t);
    assert(await page.locator('#centerClock.warn').count() === 1, 'center clock has warn class');
    await page.screenshot({ path: path.join(SHOTS, 'warning.png') });
  });

  await check('1-minute warning turns the banner urgent', async () => {
    await ff(page, 50000);
    assert(await visible(page, '#warningBanner'), 'banner visible');
    assert(await page.locator('#warningBanner.urgent').count() === 1, 'urgent class');
    assert(await page.locator('#centerClock.danger').count() === 1, 'danger class on clock');
  });

  await check('warning banner can be dismissed', async () => {
    await page.click('#warningClose');
    assert(!(await visible(page, '#warningBanner')), 'banner hidden');
  });

  await check('level up shows LEVEL 2 overlay with the new blinds and updates side panel', async () => {
    await ff(page, 150);
    await sleep(200);
    const st = await S(page);
    eq(st.clock.index, 1, 'clock index');
    const l = st.config.levels[1];
    assert(await visible(page, '#overlay'), 'overlay visible');
    eq(await text(page, '#overlayTitle'), 'LEVEL 2', 'overlay title');
    eq(await text(page, '#overlayBlinds'), `${fmt(l.sb)} / ${fmt(l.bb)}`, 'overlay blinds');
    await page.screenshot({ path: path.join(SHOTS, 'levelup.png') });
    eq(await text(page, '#levelLabel'), 'Level 2', 'side label');
    eq(await text(page, '#blindsNow'), `${fmt(l.sb)} / ${fmt(l.bb)}`, 'side blinds');
    eq(await text(page, '#clockLevel'), 'LEVEL 2', 'clock level');
    assert(!(await visible(page, '#warningBanner')), 'banner gone after level up');
    eq(st.clock.running, true, 'still running');
    near(st.clock.endsAt - Date.now(), l.minutes * 60000, 3000, 'full level time');
    await dismissOverlay(page);
    assert(!(await visible(page, '#overlay')), 'overlay dismissed by click');
  });

  await check('next / prev level buttons and ←/→ keys', async () => {
    await page.click('#nextLevel');
    eq((await S(page)).clock.index, 2, 'next');
    await page.click('#prevLevel');
    eq((await S(page)).clock.index, 1, 'prev');
    await blurAll(page);
    await page.keyboard.press('ArrowRight');
    eq((await S(page)).clock.index, 2, 'ArrowRight');
    await page.keyboard.press('ArrowLeft');
    eq((await S(page)).clock.index, 1, 'ArrowLeft');
    await page.click('#prevLevel');
    await page.click('#prevLevel');
    eq((await S(page)).clock.index, 0, 'cannot go below level 1');
  });

  await check('↺ Level restarts the current level', async () => {
    await ff(page, 3000);
    await page.click('#resetLevel');
    const st = await S(page);
    near(await page.evaluate(() => { const c = window.__tholdem.state.clock; return c.running ? c.endsAt - Date.now() : c.remainingMs; }), st.config.levels[0].minutes * 60000, 2000, 'full time');
  });

  await check('break level: overlay shows break, clock shows break state', async () => {
    const st = await S(page);
    const b = st.config.levels.findIndex((l) => l.type === 'break');
    assert(b > 0, 'default structure has a break');
    for (let i = st.clock.index; i < b - 1; i++) await page.click('#nextLevel');
    eq((await S(page)).clock.index, b - 1, 'at level before break');
    if (!(await S(page)).clock.running) await page.click('#playPause');
    await ff(page, 100);
    await sleep(200);
    eq((await S(page)).clock.index, b, 'on the break');
    assert(await visible(page, '#overlay'), 'overlay');
    assert(await page.locator('#overlay.break').count() === 1, 'overlay has break class');
    assert(/BREAK/.test(await text(page, '#overlayKicker') + await text(page, '#overlayTitle')), 'overlay says break');
    await page.screenshot({ path: path.join(SHOTS, 'break.png') });
    await dismissOverlay(page);
    eq(await text(page, '#clockLevel'), 'BREAK', 'clock level label');
    eq(await text(page, '#clockState'), 'On break', 'clock state');
    assert(await page.locator('#centerClock.on-break').count() === 1, 'on-break class');
    eq(await text(page, '#nextBreak'), 'Now', 'next break says now');
  });

  await check('"pause after break" pauses the clock when the break ends', async () => {
    await tab(page, 'structure');
    await page.check('#pauseAfterBreak');
    eq((await S(page)).config.pauseAfterBreak, true, 'setting saved');
    await tab(page, 'table');
    const b = (await S(page)).clock.index;
    await ff(page, 100);
    await sleep(200);
    const st = await S(page);
    eq(st.clock.index, b + 1, 'moved past the break');
    eq(st.clock.running, false, 'clock paused');
    eq(await text(page, '#clockState'), 'Paused', 'state label');
    near(st.clock.remainingMs, st.config.levels[b + 1].minutes * 60000, 2000, 'full level waiting');
    await dismissOverlay(page);
  });

  await check('auto-extend: running past the last level appends a bigger level and keeps going', async () => {
    const n = (await S(page)).config.levels.length;
    await tab(page, 'structure');
    eq(await page.isChecked('#autoExtend'), true, 'auto-extend on by default');
    await page.click(`#structureBody tr[data-i="${n - 1}"] [data-act="go"]`);
    await tab(page, 'table');
    await blurAll(page);
    if (!(await S(page)).clock.running) await page.click('#playPause');
    await sleep(300);
    let st = await S(page);
    eq(st.config.levels.length, n + 1, 'one level queued after the last');
    const a = st.config.levels[n - 1];
    const b = st.config.levels[n];
    assert(b.bb > a.bb && b.sb > a.sb, 'queued level is bigger');
    await ff(page, 100);
    await sleep(200);
    st = await S(page);
    eq([st.clock.index, st.clock.running, st.clock.finished], [n, true, false], 'moved on to the new level');
    await dismissOverlay(page);
  });

  await check('clock finishing the last level shows the end state (auto-extend off)', async () => {
    await tab(page, 'structure');
    await page.uncheck('#autoExtend');
    const n = (await S(page)).config.levels.length;
    await page.click(`#structureBody tr[data-i="${n - 1}"] [data-act="go"]`);
    await tab(page, 'table');
    await blurAll(page);
    if (!(await S(page)).clock.running) await page.click('#playPause');
    await ff(page, 100);
    await sleep(200);
    const st = await S(page);
    eq(st.config.levels.length, n, 'no level added');
    eq(st.clock.finished, true, 'finished');
    eq(st.clock.running, false, 'stopped');
    assert((await text(page, '#playPause')).includes('Finished'), 'button says finished');
    eq(await text(page, '#clockState'), 'Structure complete', 'state label');
    assert(await visible(page, '#overlay'), 'end overlay');
    await dismissOverlay(page);
  });

  await check('no JS errors during clock flows', async () => noErrors(page));
  await page.context().close();
}

async function testStructure() {
  section = 'structure';
  const page = await openApp();
  await tab(page, 'structure');

  await check('structure table renders one row per level/break', async () => {
    const st = await S(page);
    eq(await page.locator('#structureBody tr').count(), st.config.levels.length, 'rows');
    eq(await page.locator('#structureBody tr.is-break').count(), st.config.levels.filter((l) => l.type === 'break').length, 'break rows');
  });

  await check('edit SB / BB / ante / minutes inline', async () => {
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="sb"]', 40);
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="bb"]', 80);
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="ante"]', 10);
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="minutes"]', 12);
    const l = (await S(page)).config.levels[0];
    eq([l.sb, l.bb, l.ante, l.minutes], [40, 80, 10, 12], 'level 0');
    await tab(page, 'table');
    eq(await text(page, '#blindsNow'), '40 / 80', 'table updates');
    eq(await text(page, '#clockTime'), '12:00', 'clock picks up new minutes');
    await tab(page, 'structure');
  });

  await check('clock stays on the same level when rows are inserted/deleted/moved before it', async () => {
    // Jump to the 4th row (index 3).
    await page.click('#structureBody tr[data-i="3"] [data-act="go"]');
    const before = await S(page);
    const cur = before.config.levels[3];
    eq(before.clock.index, 3, 'at index 3');
    await page.click('#structureBody tr[data-i="0"] [data-act="dup"]');
    let st = await S(page);
    eq(st.clock.index, 4, 'index shifted after duplicate above');
    eq(st.config.levels[st.clock.index], cur, 'same level after insert');
    await page.click('#structureBody tr[data-i="0"] [data-act="del"]');
    st = await S(page);
    eq(st.clock.index, 3, 'index shifted back after delete above');
    eq(st.config.levels[st.clock.index], cur, 'same level after delete');
    await page.click('#structureBody tr[data-i="0"] [data-act="down"]');
    st = await S(page);
    eq(st.config.levels[st.clock.index], cur, 'same level after moving rows above');
    eq(await page.locator('#structureBody tr.is-current').getAttribute('data-i'), String(st.clock.index), 'highlighted row');
    await page.click('#structureBody tr[data-i="0"] [data-act="up"]').catch(() => {}); // row 0 "up" is disabled
    await page.click('#structureBody tr[data-i="1"] [data-act="up"]');
    st = await S(page);
    eq([st.config.levels[0].sb, st.config.levels[0].bb], [40, 80], 'moved back');
  });

  await check('+ Level and + Break append rows', async () => {
    const n = (await S(page)).config.levels.length;
    await page.click('#addLevel');
    let st = await S(page);
    eq(st.config.levels.length, n + 1, 'level added');
    const last = st.config.levels[n];
    const prev = st.config.levels.slice(0, n).reverse().find((l) => l.type !== 'break');
    eq(last.type, 'level', 'type');
    assert(last.bb > prev.bb, 'new level has bigger blinds');
    await page.click('#addBreak');
    st = await S(page);
    eq(st.config.levels[n + 1].type, 'break', 'break added');
    eq(await page.locator('#structureBody tr').count(), n + 2, 'rows rendered');
  });

  await check('deleting the current level keeps the clock on a valid level', async () => {
    const st0 = await S(page);
    const i = st0.clock.index;
    const nextLvl = st0.config.levels[i + 1];
    await page.click(`#structureBody tr[data-i="${i}"] [data-act="del"]`);
    const st = await S(page);
    eq(st.clock.index, i, 'index');
    eq(st.config.levels[i], nextLvl, 'now on the following level');
  });

  await check('Set all level lengths', async () => {
    await page.click('#setAllMinutes');
    await page.fill('#allMin', '7');
    await page.click('#allMinOk');
    const st = await S(page);
    assert(st.config.levels.filter((l) => l.type !== 'break').every((l) => l.minutes === 7), 'all levels 7 min');
    assert(st.config.levels.filter((l) => l.type === 'break').every((l) => l.minutes !== 7), 'breaks untouched');
  });

  await check('preset (Turbo) replaces the structure after confirm and resets to level 1', async () => {
    await page.click('[data-preset="turbo"]');
    assert(await visible(page, '#modal'), 'confirm modal (clock is not at level 1)');
    await page.click('#modalBody [data-ok]');
    const st = await S(page);
    eq(st.clock.index, 0, 'reset to level 1');
    const lv = st.config.levels.filter((l) => l.type !== 'break');
    eq(lv.length, 14, 'turbo level count');
    assert(lv.every((l) => l.minutes === 10), 'turbo 10-minute levels');
    eq(st.config.levels.filter((l) => l.type === 'break').every((l) => l.minutes === 5), true, '5-minute breaks');
  });

  await check('Generate with custom options', async () => {
    await page.fill('#genCount', '6');
    await page.fill('#genMinutes', '20');
    await page.fill('#genBreakEvery', '0');
    await page.selectOption('#genAntes', 'none');
    await page.click('#genBtn');
    if (await visible(page, '#modal')) await page.click('#modalBody [data-ok]');
    const st = await S(page);
    eq(st.config.levels.length, 6, '6 levels, no breaks');
    assert(st.config.levels.every((l) => l.minutes === 20 && !l.ante), '20 min, no antes');
    for (let i = 1; i < 6; i++) assert(st.config.levels[i].bb > st.config.levels[i - 1].bb, 'blinds increase');
    assert((await text(page, '#genSummary')).includes('6 levels'), 'summary');
  });

  await check('no JS errors in structure editing', async () => noErrors(page));
  await page.context().close();
}

async function testPlayers() {
  section = 'players';
  const page = await openApp();
  await tab(page, 'players');

  for (const n of [2, 5, 12]) {
    await check(`player count ${n} renders ${n} seats`, async () => {
      await setInput(page, '#playerCount', n);
      eq(await page.locator('#nameGrid input').count(), n, 'name inputs');
      await tab(page, 'table');
      eq(await page.locator('.seat').count(), n, 'seats');
      eq(await text(page, '#playersLeft'), `${n} / ${n}`, 'players left');
      await page.screenshot({ path: path.join(SHOTS, `seats-${n}.png`) });
      await tab(page, 'players');
    });
  }

  await check('player count is clamped to 2..12', async () => {
    await setInput(page, '#playerCount', 99);
    eq((await S(page)).game.players.length, 12, 'max 12');
    await setInput(page, '#playerCount', 0);
    eq((await S(page)).game.players.length, 2, 'min 2');
    await setInput(page, '#playerCount', 8);
  });

  await check('rename a player shows on the table', async () => {
    await page.fill('#nameGrid input[data-seat="0"]', 'Alice QA');
    await tab(page, 'table');
    assert((await page.locator('.seat .seat-name').allInnerTexts()).includes('Alice QA'), 'name on seat');
    await tab(page, 'players');
  });

  await check('empty name falls back to "Player N"', async () => {
    await page.fill('#nameGrid input[data-seat="1"]', '');
    eq((await S(page)).game.players[1].name, 'Player 2', 'fallback name');
  });

  await check('starting stack change before the first hand updates every stack', async () => {
    await setInput(page, '#startingStack', 25000);
    const st = await S(page);
    assert(st.game.players.every((p) => p.stack === 25000), 'stacks = 25000');
    eq(await text(page, '#chipsInPlay'), fmt(25000 * 8), 'chips in play');
  });

  await check('prize pool and payouts follow buy-in and places', async () => {
    await setInput(page, '#buyIn', 50);
    await page.locator('#buyIn').dispatchEvent('input');
    const st = await S(page);
    eq(await text(page, '#prizePool'), '$400', 'prize pool 8 × 50');
    const pays = await page.locator('#payoutList li').allInnerTexts();
    const pct = st.config.payoutPercents;
    eq(pays.length, pct.length, 'payout rows');
    eq(pays.map((s) => Number(s.replace(/[^\d.]/g, ''))).reduce((a, b) => a + b, 0), 400, 'payouts add up');
  });

  await check('no JS errors on players tab', async () => noErrors(page));
  await page.context().close();
}

async function testHand() {
  section = 'hand';
  const page = await openApp();
  // Deterministic simple structure: level 1 = 50/100, no ante.
  await page.evaluate(() => {
    const s = window.__tholdem.state;
    s.config.levels[0] = { type: 'level', sb: 50, bb: 100, ante: 0, minutes: 15 };
  });
  await tab(page, 'structure');
  await tab(page, 'table');
  const TOTAL = 8 * 10000;
  const conserved = async (msg) => eq(await chipTotal(page), TOTAL, 'chips conserved ' + (msg || ''));

  await check('New hand posts SB and BB', async () => {
    await page.click('#newHand');
    const st = await S(page);
    const g = st.game;
    eq(g.handNumber, 1, 'hand number');
    const sb = g.players.find((p) => p.seat === g.lastBlinds.sbSeat);
    const bb = g.players.find((p) => p.seat === g.lastBlinds.bbSeat);
    eq([sb.stack, sb.bet, bb.stack, bb.bet], [9950, 50, 9900, 100], 'blinds posted');
    eq(sb.seat, (g.dealerSeat + 1) % 8, 'SB left of button');
    eq(await text(page, '#potValue'), '150', 'pot shows 150');
    eq(await page.locator('.badge.sb').count(), 1, 'SB badge');
    eq(await page.locator('.badge.bb').count(), 1, 'BB badge');
    eq(await selectedSeat(page), (g.lastBlinds.bbSeat + 1) % 8, 'UTG auto-selected');
    await conserved();
  });

  await check('chip tray clicks accumulate the bet amount', async () => {
    const chips = await page.locator('#chipTray .chip').evaluateAll((els) => els.map((e) => Number(e.dataset.v)));
    await page.click(`#chipTray .chip[data-v="${chips[1]}"]`);
    await page.click(`#chipTray .chip[data-v="${chips[1]}"]`);
    await page.click(`#chipTray .chip[data-v="${chips[0]}"]`);
    eq(Number(await page.inputValue('#betAmount')), chips[1] * 2 + chips[0], 'accumulated');
    await page.click('#betClear');
    eq(await page.inputValue('#betAmount'), '', 'cleared');
    await page.click(`#chipTray .chip[data-v="${chips[1]}"]`);
    await page.click(`#chipTray .chip[data-v="${chips[1]}"]`);
    await page.click(`#chipTray .chip[data-v="${chips[1]}"]`);
  });

  let utg;
  await check('Bet places chips from the selected player and moves selection', async () => {
    utg = await selectedSeat(page);
    const amt = Number(await page.inputValue('#betAmount'));
    await btn(page, '#betPlace');
    const g = (await S(page)).game;
    const p = g.players.find((x) => x.seat === utg);
    eq([p.stack, p.bet], [10000 - amt, amt], 'bet placed');
    eq(await selectedSeat(page), (utg + 1) % 8, 'next player selected');
    await conserved();
  });

  await check('Call matches the biggest bet', async () => {
    const seat = await selectedSeat(page);
    const label = await text(page, '#callBtn');
    assert(/Call 300/.test(label), 'call label: ' + label);
    await btn(page, '#callBtn');
    const p = (await S(page)).game.players.find((x) => x.seat === seat);
    eq(p.bet, 300, 'called');
    await conserved();
  });

  await check('Undo reverts the last chip action', async () => {
    const before = await S(page);
    await btn(page, '#callBtn');
    await btn(page, '#undoBtn');
    eq((await S(page)).game, before.game, 'game restored');
    await blurAll(page);
    await btn(page, '#callBtn');
    await page.keyboard.press('Control+z');
    eq((await S(page)).game, before.game, 'Ctrl+Z restores');
  });

  await check('Fold marks the player folded and moves on', async () => {
    const sel = await selectedSeat(page);
    await btn(page, '#foldBtn');
    const g = (await S(page)).game;
    eq(g.players[sel].folded, true, 'folded');
    assert(await page.locator(`.seat[data-id="${g.players[sel].id}"].folded`).count() === 1, 'seat greyed');
    assert((await selectedSeat(page)) !== sel, 'selection moved on');
    await conserved();
  });

  await check('everyone folds to one player -> pot auto-awarded (uncalled raise returned)', async () => {
    // Fold every live player except `keep` (the UTG raiser).
    const keep = utg;
    const pot = await page.evaluate(() => { const g = window.__tholdem.state.game; return g.pot + g.players.reduce((s, p) => s + p.bet, 0); });
    const stackBefore = (await S(page)).game.players[keep].stack;
    for (let i = 0; i < 12; i++) {
      const g = (await S(page)).game;
      const live = g.players.filter((p) => !p.out && !p.folded);
      if (live.length <= 1) break;
      const target = live.find((p) => p.seat !== keep);
      await selectSeat(page, target.seat);
      await btn(page, '#foldBtn');
    }
    const g = (await S(page)).game;
    eq(g.pot, 0, 'pot empty after auto-award');
    assert(g.players.every((p) => p.bet === 0), 'bets cleared');
    eq(g.players[keep].stack, stackBefore + pot, 'last player standing gets the whole pot');
    await conserved();
    assert(await page.locator('.seat.winner').count() === 1, 'winner flashed');
  });

  await check('Collect sweeps bets into the pot; Award to a single winner', async () => {
    await btn(page, '#newHand');
    const g0 = (await S(page)).game;
    const sel = await selectedSeat(page);
    await btn(page, '#callBtn'); // UTG calls 100
    await btn(page, '#collectBtn');
    let g = (await S(page)).game;
    eq(g.pot, 250, 'pot collected');
    assert(g.players.every((p) => p.bet === 0), 'no bets left');
    await conserved('after collect');
    const before = g.players.find((p) => p.seat === g0.lastBlinds.bbSeat).stack;
    await btn(page, '#awardBtn');
    assert((await text(page, '#awardBtn')).includes('Confirm'), 'award mode');
    await clickSeat(page, g0.lastBlinds.bbSeat);
    await btn(page, '#awardBtn');
    g = (await S(page)).game;
    eq(g.pot, 0, 'pot empty');
    eq(g.players.find((p) => p.seat === g0.lastBlinds.bbSeat).stack, before + 250, 'winner paid');
    await conserved('after award');
    void sel;
  });

  await check('uncalled part of a bet is returned when the pot is awarded', async () => {
    await btn(page, '#newHand');
    const g0 = (await S(page)).game;
    const u = await selectedSeat(page);
    const before = g0.players[u].stack;
    await page.fill('#betAmount', '1000');
    await btn(page, '#betPlace');
    await btn(page, '#awardBtn'); // everyone else still live -> award mode
    await clickSeat(page, g0.lastBlinds.bbSeat);
    await btn(page, '#awardBtn');
    const g = (await S(page)).game;
    // BB (100) matched only 100 of the 1000 -> 900 goes back to the bettor.
    eq(g.players[u].stack, before - 100, 'bettor gets 900 back');
    await conserved('after uncalled return');
  });

  await check('Split pot between two winners', async () => {
    await btn(page, '#newHand');
    const g0 = (await S(page)).game;
    const { sbSeat, bbSeat } = g0.lastBlinds;
    await selectSeat(page, sbSeat);
    await btn(page, '#callBtn'); // SB completes to 100
    const stacks = (await S(page)).game.players.map((p) => p.stack);
    const pot = await page.evaluate(() => { const g = window.__tholdem.state.game; return g.pot + g.players.reduce((s, p) => s + p.bet, 0); });
    await btn(page, '#awardBtn');
    await clickSeat(page, sbSeat);
    await clickSeat(page, bbSeat);
    assert(/split/i.test(await text(page, '#selectedInfo')), 'split label');
    await btn(page, '#awardBtn');
    const g = (await S(page)).game;
    const gainSb = g.players[sbSeat].stack - stacks[sbSeat];
    const gainBb = g.players[bbSeat].stack - stacks[bbSeat];
    eq(gainSb + gainBb, pot, 'whole pot split');
    eq(gainSb, gainBb, 'even split');
    await conserved('after split');
  });

  await check('All-in moves the whole stack into the bet', async () => {
    await btn(page, '#newHand');
    const seat = await selectedSeat(page);
    const stack = (await S(page)).game.players[seat].stack;
    await btn(page, '#allInBtn');
    const p = (await S(page)).game.players[seat];
    eq([p.stack, p.bet], [0, stack], 'all in');
    await conserved('after all-in');
    await btn(page, '#undoBtn');
  });

  await check('New hand moves the button clockwise', async () => {
    const d0 = (await S(page)).game.dealerSeat;
    await btn(page, '#newHand');
    eq((await S(page)).game.dealerSeat, (d0 + 1) % 8, 'button moved');
    await conserved('uncollected pot carried');
  });

  await check('no JS errors in hand tracking', async () => noErrors(page));
  await page.screenshot({ path: path.join(SHOTS, 'table-hand.png') });
  await page.context().close();
}

async function testBust() {
  section = 'bust';
  const page = await openApp();
  await page.evaluate(() => {
    window.__tholdem.state.config.levels[0] = { type: 'level', sb: 50, bb: 100, ante: 0, minutes: 15 };
  });

  async function allInAndCall(winnerSeat, loserSeat) {
    await btn(page, '#newHand');
    await selectSeat(page, winnerSeat);
    await btn(page, '#allInBtn');
    await selectSeat(page, loserSeat);
    await btn(page, '#callBtn');
    await btn(page, '#awardBtn');
    await clickSeat(page, winnerSeat);
    await btn(page, '#awardBtn');
    await page.waitForSelector('#modal:not([hidden])', { timeout: 3000 });
  }

  await check('player at 0 after award gets the knock-out / rebuy prompt', async () => {
    await allInAndCall(3, 4);
    const t = await text(page, '#modalBody');
    assert(/out of chips/i.test(t), 'prompt text: ' + t);
    assert(/8th/.test(t), 'mentions 8th place: ' + t);
  });

  await check('Knock out assigns 8th place and updates players left', async () => {
    await page.click('#modalBody [data-bust]');
    const g = (await S(page)).game;
    const p = g.players[4];
    eq([p.out, p.place], [true, 8], 'out in 8th');
    eq(await text(page, '#playersLeft'), '7 / 8', 'players left');
    eq(await page.locator('.seat.out').count(), 1, 'seat shows out');
  });

  await check('Rebuy from the bust prompt restores chips and grows the prize pool', async () => {
    await allInAndCall(3, 5);
    await page.click('#modalBody [data-rebuy]');
    const st = await S(page);
    const p = st.game.players[5];
    eq([p.out, p.stack, p.rebuys], [false, st.config.rebuyChips, 1], 'rebought');
    eq(await text(page, '#prizePool'), '$' + (8 * st.config.buyIn + st.config.rebuyCost), 'pool includes rebuy');
  });

  await check('Add-on via the seat dialog', async () => {
    await openSeatMenu(page, 6); // tap to select, tap again for the player dialog
    await page.click('#modalBody [data-addon]');
    const st = await S(page);
    eq(st.game.players[6].addons, 1, 'addon counted');
    eq(st.game.players[6].stack, 10000 + st.config.addonChips, 'addon chips');
    eq(await text(page, '#prizePool'), '$' + (8 * st.config.buyIn + st.config.rebuyCost + st.config.addonCost), 'pool includes add-on');
  });

  await check('payout list and standings match the prize pool', async () => {
    const st = await S(page);
    const net = 8 * st.config.buyIn + st.config.rebuyCost + st.config.addonCost;
    const pays = (await page.locator('#payoutList li').allInnerTexts()).map((s) => Number(s.replace(/[^\d.]/g, '')));
    eq(pays.reduce((a, b) => a + b, 0), net, 'payouts sum to pool');
    await tab(page, 'players');
    const rows = await page.locator('#standings tbody tr').count();
    eq(rows, 8, 'standings rows');
    assert((await text(page, '#standings')).includes('8th'), 'knocked-out player ranked 8th');
    await tab(page, 'table');
  });

  await check('knock out via seat dialog, then last-two → champion overlay', async () => {
    // Knock everyone out except seats 0 and 3 via the dialog.
    for (const seat of [1, 2, 5, 6, 7]) {
      await openSeatMenu(page, seat);
      await page.click('#modalBody [data-bust]');
      await page.click('#modalBody [data-ok]');
      await dismissOverlay(page);
    }
    let st = await S(page);
    eq(st.game.players.filter((p) => !p.out).map((p) => p.seat), [0, 3], 'two left');
    const places = st.game.players.filter((p) => p.out).map((p) => p.place).sort((a, b) => a - b);
    eq(places, [3, 4, 5, 6, 7, 8], 'unique places 3..8');
    await allInAndCall(3, 0);
    await page.click('#modalBody [data-bust]');
    await sleep(300);
    assert(await visible(page, '#overlay'), 'champion overlay');
    assert(/CHAMPION/.test(await text(page, '#overlayKicker')), 'champion kicker');
    st = await S(page);
    eq(st.game.players[0].place, 2, 'runner-up 2nd');
    await page.screenshot({ path: path.join(SHOTS, 'champion.png') });
    await dismissOverlay(page);
    eq(await chipTotal(page), st.game.players[3].stack, 'champion holds every chip');
  });

  await check('no JS errors in bust flow', async () => noErrors(page));
  await page.context().close();
}

async function testChips() {
  section = 'chips';
  const page = await openApp();
  await tab(page, 'chips');

  await check('chip editor shows every denomination and the summary matches the starting stack', async () => {
    const st = await S(page);
    eq(await page.locator('#chipEditor .chip-row').count(), st.config.chips.length, 'rows');
    assert((await text(page, '#chipSummary')).includes('matches'), 'summary matches');
  });

  await check('edit per-player count updates the summary (mismatch warning)', async () => {
    await setInput(page, '#chipEditor .chip-row[data-i="0"] [data-f="perPlayer"]', 50);
    const st = await S(page);
    eq(st.config.chips[0].perPlayer, 50, 'count saved');
    assert(/≠ starting stack/.test(await text(page, '#chipSummary')), 'mismatch shown');
  });

  await check('edit chip value updates the chip tray', async () => {
    await setInput(page, '#chipEditor .chip-row[data-i="0"] [data-f="value"]', 5);
    const st = await S(page);
    eq(st.config.chips[0].value, 5, 'value saved');
    eq(await page.locator('#chipTray .chip[data-v="5"]').count(), 1, 'tray chip');
  });

  await check('auto-distribute makes the summary match the starting stack', async () => {
    await page.click('#autoDistribute');
    const st = await S(page);
    const total = st.config.chips.reduce((s, c) => s + c.value * c.perPlayer, 0);
    eq(total, st.config.startingStack, 'stack from chips');
    assert((await text(page, '#chipSummary')).includes('matches'), 'summary matches');
  });

  await check('add and remove a denomination', async () => {
    const n = (await S(page)).config.chips.length;
    await page.click('#addChip');
    eq((await S(page)).config.chips.length, n + 1, 'added');
    await page.click(`#chipEditor .chip-row[data-i="${n}"] [data-act="del"]`);
    eq((await S(page)).config.chips.length, n, 'removed');
  });

  await check('no JS errors on chips tab', async () => noErrors(page));
  await page.screenshot({ path: path.join(SHOTS, 'chips.png'), fullPage: true });
  await page.context().close();
}

async function testSettings() {
  section = 'settings';
  const page = await openApp();
  await tab(page, 'settings');

  await check('felt swatch changes body[data-felt]', async () => {
    await page.click('.swatch[data-felt="blue"]');
    eq(await page.getAttribute('body', 'data-felt'), 'blue', 'felt');
    eq((await S(page)).config.theme.felt, 'blue', 'saved');
  });

  await check('rail style changes body[data-rail]', async () => {
    await page.selectOption('#railStyle', 'wood');
    eq(await page.getAttribute('body', 'data-rail'), 'wood', 'rail');
  });

  await check('mute button and M key toggle sound', async () => {
    await page.click('#muteBtn');
    eq((await S(page)).config.sound.enabled, false, 'muted');
    eq(await page.isChecked('#soundEnabled'), false, 'checkbox follows');
    await blurAll(page);
    await page.keyboard.press('m');
    eq((await S(page)).config.sound.enabled, true, 'unmuted by M');
  });

  await check('every PokerAudio sound plays without throwing', async () => {
    const res = await page.evaluate(() => {
      const out = {};
      window.PokerAudio.ensure();
      for (const k of Object.keys(window.PokerAudio.SOUNDS)) {
        try { const d = window.PokerAudio.play(k, 'levelUp'); out[k] = typeof d === 'number' ? 'ok' : 'bad return ' + d; } catch (e) { out[k] = 'threw ' + e.message; }
      }
      return out;
    });
    const bad = Object.entries(res).filter(([, v]) => v !== 'ok');
    eq(bad, [], 'sounds');
  });

  await check('sound preview buttons work', async () => {
    for (const b of await page.locator('[data-act="preview"]').all()) await b.click();
    noErrors(page);
  });

  await check('felt logo text updates the table', async () => {
    await page.fill('#feltText', 'QA NIGHT');
    eq(await page.innerText('#feltBrand'), 'QA NIGHT', 'felt text');
  });

  await check('help tab lists the keyboard shortcuts', async () => {
    await tab(page, 'help');
    const t = await text(page, '#helpContent');
    for (const k of ['Space', '→', '←', '↑', '↓', 'N', 'C', 'X', 'Ctrl', 'Z', 'F', 'M', '1', '6']) assert(t.includes(k), 'help mentions ' + k);
    await page.screenshot({ path: path.join(SHOTS, 'help.png'), fullPage: true });
  });

  await check('number keys 1–6 switch tabs', async () => {
    await blurAll(page);
    await page.keyboard.press('2');
    assert(await visible(page, '#view-structure'), 'structure view');
    await page.keyboard.press('1');
    assert(await visible(page, '#view-table'), 'table view');
  });

  await check('Big clock mode: button and B key toggle it, and it shows the live time/blinds', async () => {
    await tab(page, 'table');
    await page.click('#bigClockBtn');
    assert(await page.evaluate(() => document.body.classList.contains('mode-bigclock')), 'body.mode-bigclock');
    assert(await visible(page, '#bigClock'), 'big clock visible');
    const st = await S(page);
    const l = st.config.levels[st.clock.index];
    eq(await text(page, '#bcTime'), await text(page, '#clockTime'), 'same time as table clock');
    eq(await text(page, '#bcBlinds'), `${fmt(l.sb)} / ${fmt(l.bb)}`, 'blinds');
    await blurAll(page);
    await page.keyboard.press('b');
    assert(!(await page.evaluate(() => document.body.classList.contains('mode-bigclock'))), 'B toggles back');
  });

  await check('no JS errors in settings', async () => noErrors(page));
  await page.context().close();
}

async function testPersistence() {
  section = 'persistence';
  const page = await openApp();
  await page.evaluate(() => { window.__tholdem.state.config.levels[0] = { type: 'level', sb: 50, bb: 100, ante: 0, minutes: 15 }; });
  await tab(page, 'players');
  await page.fill('#nameGrid input[data-seat="2"]', 'Persisted Pat');
  await tab(page, 'table');
  await page.click('#nextLevel');
  await page.click('#nextLevel');
  await page.click('#newHand');
  await page.click('#callBtn');
  await ff(page, 7 * 60000);
  const before = await S(page);
  await sleep(400); // debounced save

  await check('paused mid-tournament state survives a reload', async () => {
    await page.reload();
    await page.waitForFunction(() => window.__tholdem);
    const st = await S(page);
    eq(st.clock.index, 2, 'level');
    eq(st.clock.running, false, 'paused');
    eq(await text(page, '#clockTime'), '7:00', 'remaining');
    eq(st.game.players[2].name, 'Persisted Pat', 'name');
    eq(st.game, before.game, 'players, bets and pot');
    eq(await text(page, '#potValue'), fmt(before.game.pot + before.game.players.reduce((s, p) => s + p.bet, 0)), 'pot shown');
  });

  await check('a running clock keeps running across reload', async () => {
    await page.click('#playPause');
    await sleep(400);
    await page.reload();
    await page.waitForFunction(() => window.__tholdem);
    await sleep(1300);
    const st = await S(page);
    eq(st.clock.running, true, 'running');
    const t = await text(page, '#clockTime');
    assert(/^6:5\d$/.test(t), 'still counting down from 7:00, got ' + t);
  });

  await check('export setup / import setup round-trip', async () => {
    await tab(page, 'players');
    await page.fill('#eventName', 'QA Export Night');
    await tab(page, 'structure');
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="bb"]', 120);
    await tab(page, 'settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
    const file = path.join(SHOTS, 'export.json');
    await dl.saveAs(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq(data.config.eventName, 'QA Export Night', 'exported event name');
    eq(data.config.levels[0].bb, 120, 'exported level');
    eq(dl.suggestedFilename(), 'qa-export-night-setup.json', 'file name');
    // Reset everything, then import.
    await page.click('#factoryReset');
    await page.click('#modalBody [data-ok]');
    eq((await S(page)).config.eventName, 'Friday Night Poker', 'reset to defaults');
    await page.setInputFiles('#importFile', file);
    await page.waitForFunction(() => window.__tholdem.state.config.eventName === 'QA Export Night', null, { timeout: 3000 });
    const st = await S(page);
    eq(st.config.levels, data.config.levels, 'levels imported');
    eq(await text(page, '#eventTitle'), 'QA Export Night', 'title shown');
  });

  await check('import of a non-THoldem file shows an error and keeps the setup', async () => {
    const bad = path.join(SHOTS, 'bad.json');
    fs.writeFileSync(bad, '{"hello": 1}');
    await page.setInputFiles('#importFile', bad);
    await sleep(300);
    assert(/not a THoldem setup/.test(await text(page, '#toast')), 'toast');
    eq((await S(page)).config.eventName, 'QA Export Night', 'unchanged');
  });

  await check('no JS errors in persistence flows', async () => noErrors(page));
  await page.context().close();
}

async function testMobile() {
  section = 'mobile';
  const page = await openApp({ viewport: { width: 390, height: 844 }, mobile: true, touch: true });

  for (const view of ['table', 'structure', 'players', 'chips', 'settings', 'help']) {
    await check(`no horizontal overflow on ${view} tab at 390px`, async () => {
      await page.evaluate((v) => document.querySelector(`.tab[data-view="${v}"]`).click(), view);
      await sleep(150);
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      assert(r.sw <= r.iw, `scrollWidth ${r.sw} > innerWidth ${r.iw}`);
      await page.screenshot({ path: path.join(SHOTS, `mobile-${view}.png`), fullPage: true });
    });
  }

  await check('table and controls are visible on mobile', async () => {
    await page.evaluate(() => document.querySelector('.tab[data-view="table"]').click());
    assert(await visible(page, '#pokerTable'), 'table');
    assert(await visible(page, '#playPause'), 'play button');
    assert(await visible(page, '#newHand'), 'new hand');
    eq(await page.locator('.seat').count(), 8, 'seats');
    const box = await page.locator('#pokerTable').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390, 'table fits horizontally');
  });

  await check('mobile: seats stay inside the viewport with 12 players', async () => {
    await page.evaluate(() => { document.querySelector('.tab[data-view="players"]').click(); });
    await setInput(page, '#playerCount', 12);
    await page.evaluate(() => document.querySelector('.tab[data-view="table"]').click());
    await sleep(200);
    const boxes = await page.locator('.seat .seat-card').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
    const bad = boxes.filter(([l, r]) => l < 0 || r > 390);
    eq(bad.length, 0, 'seats outside viewport');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-12.png'), fullPage: true });
  });

  await check('mobile: 12 seat cards do not overlap each other', async () => {
    const rects = await page.locator('.seat .seat-card').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }));
    const overlaps = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]; const b = rects[j];
      const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (w > 4 && h > 4) overlaps.push(`${i + 1}&${j + 1}`);
    }
    eq(overlaps, [], 'overlapping seat pairs');
  });

  await check('mobile: structure table number inputs are wide enough to show 4-digit blinds', async () => {
    await page.evaluate(() => document.querySelector('.tab[data-view="structure"]').click());
    await sleep(150);
    const clipped = await page.locator('#structureBody input[type=number]').evaluateAll((els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.dataset.f + '=' + e.value));
    eq(clipped.slice(0, 5), [], 'clipped inputs (first 5)');
  });

  await check('no JS errors on mobile', async () => noErrors(page));
  await page.context().close();
}

// ------------------------------------------------------------ edge cases

async function testEdgeCases() {
  section = 'edge';
  let page = await openApp();

  await check('heads-up: the button posts the small blind, and it alternates', async () => {
    await tab(page, 'players');
    await setInput(page, '#playerCount', 2);
    await tab(page, 'table');
    await page.evaluate(() => { window.__tholdem.state.config.levels[0] = { type: 'level', sb: 50, bb: 100, ante: 0, minutes: 15 }; });
    await btn(page, '#newHand');
    let g = (await S(page)).game;
    eq(g.lastBlinds.sbSeat, g.dealerSeat, 'dealer is SB');
    const d1 = g.dealerSeat;
    await btn(page, '#newHand');
    g = (await S(page)).game;
    assert(g.dealerSeat !== d1, 'button alternates');
    eq(g.lastBlinds.sbSeat, g.dealerSeat, 'dealer is SB again');
    eq(await chipTotal(page), 20000, 'chips conserved');
  });

  await check('big-blind ante: BB posts ante + blind, chips conserved', async () => {
    await page.evaluate(() => { window.__tholdem.state.config.levels[0] = { type: 'level', sb: 100, bb: 200, ante: 200, minutes: 15 }; });
    await tab(page, 'players');
    await setInput(page, '#playerCount', 6);
    await tab(page, 'table');
    const before = await chipTotal(page);
    await btn(page, '#newHand');
    const g = (await S(page)).game;
    eq(g.pot + g.players.reduce((s, p) => s + p.bet, 0) >= 500, true, 'blinds + ante in pot');
    eq(await chipTotal(page), before, 'conserved');
  });

  await check('deleting every level leaves one valid level and no errors', async () => {
    await tab(page, 'structure');
    for (let i = 0; i < 80 && (await page.locator('#structureBody tr').count()) > 1; i++) {
      await page.click('#structureBody tr[data-i="0"] [data-act="del"]');
    }
    await page.click('#structureBody tr[data-i="0"] [data-act="del"]');
    const st = await S(page);
    eq(st.config.levels.length, 1, 'one level remains');
    eq(st.clock.index, 0, 'clock index valid');
    noErrors(page);
    await tab(page, 'table');
    eq(await text(page, '#blindsNext'), 'Final level', 'next says final level');
  });

  await check('0 or negative minutes in the structure are clamped to 0.5', async () => {
    await tab(page, 'structure');
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="minutes"]', -5);
    eq((await S(page)).config.levels[0].minutes, 0.5, 'clamped');
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="minutes"]', 0);
    eq((await S(page)).config.levels[0].minutes, 0.5, 'clamped');
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="sb"]', -50);
    eq((await S(page)).config.levels[0].sb, 0, 'negative blind -> 0');
  });

  await check('Tab from SB to BB input keeps keyboard focus in the structure table', async () => {
    await page.click('#addLevel');
    const sb = page.locator('#structureBody tr[data-i="0"] [data-f="sb"]');
    await sb.click();
    await sb.fill('60');
    await page.keyboard.press('Tab');
    await sleep(100);
    const focused = await page.evaluate(() => { const a = document.activeElement; return a && a.dataset ? a.dataset.f || a.tagName : null; });
    eq(focused, 'bb', 'focus should move to the BB input');
  });

  await check('Tab between chip editor inputs keeps keyboard focus', async () => {
    await tab(page, 'chips');
    const v = page.locator('#chipEditor .chip-row[data-i="0"] [data-f="value"]');
    await v.click();
    await v.fill('30');
    await page.keyboard.press('Tab');
    await sleep(100);
    const tag = await page.evaluate(() => document.activeElement.tagName);
    assert(tag !== 'BODY', 'focus lost to <body> after Tab');
  });

  await context_close(page);
  page = await openApp();

  await check('toast after New hand does not cover the Bet / amount controls', async () => {
    await page.click('#newHand');
    const hits = await page.evaluate(() => ['betPlace', 'betAmount', 'callBtn', 'foldBtn'].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return document.getElementById(id).contains(el) ? '' : id + ' covered by ' + (el.id || el.className);
    }).filter(Boolean));
    eq(hits, [], 'covered controls');
    await dismissToast(page);
    await btn(page, '#undoBtn');
  });

  await check('"Add to pot" with no seat selected does not create chips out of thin air', async () => {
    const before = await chipTotal(page);
    await page.keyboard.press('Escape');
    await page.fill('#betAmount', '5000');
    assert(await page.isDisabled('#betPlace'), 'Bet button should be disabled with no seat selected');
    await page.press('#betAmount', 'Enter');
    const after = await chipTotal(page);
    await page.fill('#betAmount', '');
    eq(after, before, 'chips in play');
  });

  await check('a 30-second warning is announced as 30 seconds, not "one minute"', async () => {
    await page.evaluate(() => {
      const s = window.__tholdem.state;
      s.config.warningMinutes = 0.5;
      s.config.oneMinuteWarning = false;
      window.__said = [];
      const o = window.PokerAudio.say;
      window.PokerAudio.say = (t, ...a) => { window.__said.push(t); return o(t, ...a); };
    });
    await blurAll(page);
    if (!(await S(page)).clock.running) await page.click('#playPause');
    await page.evaluate(() => { const c = window.__tholdem.state.clock; c.endsAt = Date.now() + 25000; c.firedWarnings = []; });
    await sleep(400);
    const said = await page.evaluate(() => window.__said);
    assert(said.length > 0, 'warning spoken');
    assert(!/one minute/.test(said.join(' ')), 'spoken: ' + said.join(' | '));
    await page.click('#playPause');
    await page.evaluate(() => { const s = window.__tholdem.state; s.config.warningMinutes = 5; s.config.oneMinuteWarning = true; });
  });

  const fresh = async () => { await context_close(page); page = await openApp(); return page; };

  await check('rapid clicking Start/Pause 11× leaves the clock running and consistent', async () => {
    await fresh();
    for (let i = 0; i < 11; i++) await page.click('#playPause', { delay: 0 });
    const st = await S(page);
    eq(st.clock.running, true, 'running');
    assert(st.clock.endsAt > Date.now(), 'endsAt in the future');
  });

  await check('editing the running level\'s minutes adjusts the remaining time', async () => {
    await fresh();
    await page.click('#playPause');
    await ff(page, 10 * 60000);
    await tab(page, 'structure');
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="minutes"]', 20); // was 15 -> +5 min
    const rem = await page.evaluate(() => window.__tholdem.state.clock.endsAt - Date.now());
    near(rem, 15 * 60000, 3000, 'remaining grew by 5 min');
    await setInput(page, '#structureBody tr[data-i="0"] [data-f="minutes"]', 2); // shrink below elapsed
    await sleep(400);
    const st = await S(page);
    eq(st.clock.index >= 1, true, 'level ended because it is now shorter than elapsed time');
    await tab(page, 'table');
    await dismissOverlay(page);
  });

  await check('changing warning minutes while inside the warning window updates the banner', async () => {
    await fresh();
    await page.click('#playPause');
    await ff(page, 4 * 60000);
    assert(await visible(page, '#warningBanner'), 'banner from the 5-min warning');
    await tab(page, 'settings');
    await setInput(page, '#warningMinutes', 3);
    await tab(page, 'table');
    await sleep(300);
    // 4:00 left with a 3-minute warning: the 5-minute banner should no longer be shown.
    assert(!(await visible(page, '#warningBanner')), 'banner should hide when no longer inside the warning window');
    await ff(page, 2 * 60000 + 50000);
    assert(await visible(page, '#warningBanner'), 'banner reappears at 3 minutes');
  });

  await check('huge numbers: 1,000,000,000 starting stack renders without JS errors', async () => {
    await fresh();
    await tab(page, 'players');
    await setInput(page, '#startingStack', 1000000000);
    await tab(page, 'table');
    eq(await text(page, '#chipsInPlay'), fmt(8e9), 'chips in play');
    await page.screenshot({ path: path.join(SHOTS, 'huge.png') });
    noErrors(page);
  });

  await check('undo after changing player count does not desync seats and config', async () => {
    await fresh();
    await btn(page, '#newHand'); // something on the undo stack
    await tab(page, 'players');
    await setInput(page, '#playerCount', 4);
    await tab(page, 'table');
    await blurAll(page);
    await page.keyboard.press('Control+z');
    const st = await S(page);
    eq(st.game.players.length, st.config.playerCount, 'seat count matches configured player count');
  });

  await context_close(page);

  await check('reload with a short (≤ warning) level does not show a stale warning banner', async () => {
    page = await openApp();
    await page.evaluate(() => {
      const s = window.__tholdem.state;
      s.config.levels = [{ type: 'level', sb: 25, bb: 50, ante: 0, minutes: 5 }, { type: 'level', sb: 50, bb: 100, ante: 0, minutes: 5 }];
    });
    await tab(page, 'structure');
    await page.click('#structureBody tr[data-i="0"] [data-act="go"]').catch(() => {});
    await page.evaluate(() => { window.__tholdem.state.clock = { ...window.__tholdem.state.clock, index: 0, remainingMs: 5 * 60000 }; });
    await tab(page, 'table');
    await page.click('#nextLevel');
    await page.click('#prevLevel'); // re-arm warnings for a 5-minute level
    await page.click('#playPause');
    await sleep(400);
    const shownBefore = await visible(page, '#warningBanner');
    await page.reload();
    await page.waitForFunction(() => window.__tholdem);
    await sleep(300);
    eq(await visible(page, '#warningBanner'), shownBefore, 'banner state identical before/after reload');
    await context_close(page);
  });

  await check('pause-after-break is honoured when the break ended while the page was closed', async () => {
    page = await openApp();
    await page.evaluate(() => {
      const s = window.__tholdem.state;
      s.config.pauseAfterBreak = true;
      s.config.levels = [
        { type: 'level', sb: 25, bb: 50, ante: 0, minutes: 10 },
        { type: 'break', minutes: 10, label: 'Break' },
        { type: 'level', sb: 50, bb: 100, ante: 0, minutes: 10 },
        { type: 'level', sb: 75, bb: 150, ante: 0, minutes: 10 },
      ];
      s.clock = { ...s.clock, index: 1, running: true, endsAt: Date.now() - 2 * 60000, startedAt: Date.now() - 30 * 60000 };
      localStorage.setItem('tholdem.v1', JSON.stringify(s));
      window.onbeforeunload = null;
    });
    // Reload immediately (before the tick loop sees the expired break).
    await page.evaluate(() => location.reload());
    await page.waitForFunction(() => window.__tholdem);
    const st = await S(page);
    eq(st.clock.index, 2, 'moved to level after break');
    eq(st.clock.running, false, 'should be paused waiting for the director');
    await context_close(page);
  });

  await check('imported setup with markup in numeric fields is not executed (XSS)', async () => {
    page = await openApp();
    const evil = path.join(SHOTS, 'evil.json');
    const cfg = await page.evaluate(() => JSON.parse(JSON.stringify(window.__tholdem.state.config)));
    cfg.chips[0].value = '1"><img src=x onerror="window.__pwned=1">';
    cfg.levels[0].sb = '<img src=x onerror="window.__pwned=2">';
    fs.writeFileSync(evil, JSON.stringify({ config: cfg }));
    await tab(page, 'settings');
    await page.setInputFiles('#importFile', evil);
    await sleep(500);
    await tab(page, 'structure');
    await tab(page, 'chips');
    await sleep(300);
    eq(await page.evaluate(() => window.__pwned || 0), 0, 'injected handler ran');
    await context_close(page);
  });
}

async function context_close(page) {
  try { await page.context().close(); } catch (e) { /* already closed */ }
}

async function testRunMode() {
  section = 'run mode';
  const page = await openApp({ mode: 'run' });

  await check('a fresh setup opens in Run mode: clock only, no hand controls, pot or dealer button', async () => {
    assert(await page.evaluate(() => document.body.classList.contains('mode-run')), 'body.mode-run');
    assert(await page.locator('#modeSwitch [data-mode="run"].active').count() === 1, 'Run button active');
    assert(!(await visible(page, '#handControls')), 'hand controls hidden');
    assert(!(await visible(page, '#potArea')), 'pot hidden');
    eq(await page.locator('.dealer-btn').count(), 0, 'dealer button');
    eq(await page.locator('.badge.sb, .badge.bb').count(), 0, 'blind badges');
    assert(await visible(page, '#clockTime'), 'clock visible');
    assert((await text(page, '#blindsNow')).length > 0, 'current blinds shown');
    assert((await text(page, '#nextBreak')).length > 0, 'next break shown');
  });

  await check('Run mode: tapping a seat opens the player menu (no selection step)', async () => {
    await page.click('.seat[data-id="p1"]');
    assert(await visible(page, '#modal'), 'player menu opens');
    await page.keyboard.press('Escape');
  });

  await check('Run mode: rebuys and knockouts update players left and average stack without hand tracking', async () => {
    const st = await S(page);
    const start = st.config.startingStack;
    const n = st.game.players.length;
    await page.click('.seat[data-id="p1"]');
    await page.click('#modal [data-rebuy]');
    await dismissToast(page);
    await page.click('.seat[data-id="p2"]');
    await page.click('#modal [data-bust]');
    await page.click('#modal [data-ok]');
    await dismissToast(page);
    const total = n * start + st.config.rebuyChips;
    eq(await text(page, '#playersLeft'), `${n - 1} / ${n}`, 'players left');
    eq(await text(page, '#chipsInPlay'), fmt(total), 'chips in play');
    eq(await text(page, '#avgStack'), fmt(total / (n - 1)), 'avg stack');
  });

  await check('switching to Full mode (button and T key) brings back the hand tools, and back again', async () => {
    await page.click('#modeSwitch [data-mode="full"]');
    await dismissToast(page);
    assert(await visible(page, '#handControls'), 'hand controls shown');
    assert(await visible(page, '#potArea'), 'pot shown');
    eq((await S(page)).config.trackStacks, true, 'config.trackStacks');
    await page.keyboard.press('t');
    await dismissToast(page);
    assert(!(await visible(page, '#handControls')), 'hidden again after T');
    eq((await S(page)).config.trackStacks, false, 'back to Run');
  });

  await check('the mode survives a reload', async () => {
    await page.click('#modeSwitch [data-mode="full"]');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__tholdem && window.__tholdem.state);
    assert(await page.locator('#modeSwitch [data-mode="full"].active').count() === 1, 'Full still active');
    noErrors(page);
  });
  await context_close(page);
}

// ------------------------------------------------------------------ main

(async () => {
  browser = await chromium.launch({ headless: !process.env.HEADFUL });
  const suites = [testLoadAndClock, testRunMode, testStructure, testPlayers, testHand, testBust, testChips, testSettings, testPersistence, testMobile, testEdgeCases];
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null; // e.g. ONLY=edge|mobile
  for (const suite of suites) {
    if (only && !only.test(suite.name)) continue;
    try { await suite(); } catch (e) {
      results.push({ ok: false, label: `[${section}] suite crashed`, err: e });
      console.log(`FAIL  [${section}] suite crashed: ${e.message.split('\n')[0]}`);
    }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach((f) => console.log('  - ' + f.label));
  }
  process.exit(failed.length ? 1 : 0);
})();
