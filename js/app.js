/* THoldem — UI controller. Depends on engine.js (PokerEngine) and audio.js (PokerAudio). */
(function () {
  'use strict';

  const E = window.PokerEngine;
  const A = window.PokerAudio;
  const STORAGE_KEY = 'tholdem.v1';
  const $ = (id) => document.getElementById(id);
  const FELTS = { green: '#1f7a45', blue: '#1b4f8a', red: '#8a1f2b', purple: '#4d2a82', teal: '#0f6e6a', black: '#23262b' };
  const CUES = [
    { key: 'levelUp', label: 'Blinds go up' },
    { key: 'warning', label: 'Warning' },
    { key: 'breakStart', label: 'Break starts' },
  ];

  let S = null; // persisted state: { config, clock, game }
  const ui = {
    selected: null,
    awardMode: false,
    awardPicks: new Set(),
    banner: null, // { index, dismissed }
    overlayTimer: null,
    toastTimer: null,
    undo: [],
    wakeLock: null,
    clipNames: {},
    lastIndex: -1,
    saveTimer: null,
  };

  // ---------------------------------------------------------------- State

  function freshState(config) {
    const cfg = config || E.createDefaultConfig();
    return { config: cfg, clock: E.createClock(cfg.levels, E.warningThresholds(cfg)), game: E.createGame(cfg) };
  }

  function mergeConfig(saved) {
    const def = E.createDefaultConfig();
    const cfg = { ...def, ...saved, sound: { ...def.sound, ...(saved.sound || {}) }, theme: { ...def.theme, ...(saved.theme || {}) } };
    if (!Array.isArray(cfg.levels) || !cfg.levels.length) cfg.levels = def.levels;
    if (!Array.isArray(cfg.chips) || !cfg.chips.length) cfg.chips = def.chips;
    if (!Array.isArray(cfg.payoutPercents) || !cfg.payoutPercents.length) cfg.payoutPercents = def.payoutPercents;
    if (!Array.isArray(cfg.playerNames)) cfg.playerNames = def.playerNames;
    cfg.playerCount = E.clampInt(cfg.playerCount, 2, 12);
    // Imported files are untrusted: coerce every number and color before it reaches the DOM.
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const color = (v) => (/^#[0-9a-f]{6}$/i.test(v) ? v : '#888888');
    cfg.levels = cfg.levels.map((l) => (l && l.type === 'break'
      ? { type: 'break', minutes: Math.max(0.5, num(l.minutes, 10)), label: String(l.label || 'Break').slice(0, 24) }
      : { type: 'level', sb: Math.max(0, Math.round(num(l && l.sb, 0))), bb: Math.max(0, Math.round(num(l && l.bb, 0))), ante: Math.max(0, Math.round(num(l && l.ante, 0))), minutes: Math.max(0.5, num(l && l.minutes, 15)) }));
    cfg.chips = cfg.chips.map((c) => ({ value: Math.max(1, Math.round(num(c && c.value, 1))), color: color(c && c.color), label: String((c && c.label) || '').slice(0, 16), perPlayer: Math.max(0, Math.round(num(c && c.perPlayer, 0))) }));
    cfg.payoutPercents = cfg.payoutPercents.map((x) => Math.max(0, num(x, 0)));
    cfg.playerNames = cfg.playerNames.map((n) => String(n == null ? '' : n).slice(0, 24));
    ['startingStack', 'buyIn', 'rebuyCost', 'rebuyChips', 'addonCost', 'addonChips', 'rakePercent', 'warningMinutes'].forEach((k) => { cfg[k] = Math.max(0, num(cfg[k], def[k])); });
    cfg.startingStack = Math.max(1, Math.round(cfg.startingStack));
    cfg.sound.volume = Math.min(1, Math.max(0, num(cfg.sound.volume, 0.8)));
    if (!Object.prototype.hasOwnProperty.call(FELTS, cfg.theme.felt)) cfg.theme.felt = 'green';
    if (!['leather', 'wood', 'burgundy'].includes(cfg.theme.rail)) cfg.theme.rail = 'leather';
    cfg.currency = String(cfg.currency || '').slice(0, 3);
    return cfg;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshState();
      const saved = JSON.parse(raw);
      const config = mergeConfig(saved.config || {});
      const st = freshState(config);
      if (saved.clock && typeof saved.clock.index === 'number') st.clock = { ...st.clock, ...saved.clock };
      if (saved.game && Array.isArray(saved.game.players) && saved.game.players.length) st.game = saved.game;
      st.clock.index = E.clampInt(st.clock.index, 0, config.levels.length - 1);
      st.game = E.resizePlayers(st.game, config);
      return st;
    } catch (e) {
      console.warn('Could not load saved state', e);
      return freshState();
    }
  }

  function save(now) {
    clearTimeout(ui.saveTimer);
    const write = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch (e) { /* storage full or blocked */ }
    };
    if (now) write();
    else ui.saveTimer = setTimeout(write, 250);
  }

  const cfg = () => S.config;
  const levels = () => S.config.levels;
  const curLevel = () => levels()[S.clock.index];
  const warnings = () => E.warningThresholds(S.config);
  const fmt = (n) => E.formatChips(n, S.config.compactNumbers);
  const chipValues = () => S.config.chips.map((c) => Number(c.value)).filter((v) => v > 0);
  const smallestChip = () => Math.min(...chipValues(), Infinity) || 1;
  // Full mode counts real stacks; Run mode counts what was bought in.
  const totalChips = () => (cfg().trackStacks ? E.chipsInPlay(S.game) : E.chipsIssued(cfg(), S.game.players));
  const anteModeFor = (l) => cfg().anteMode || (l && l.ante >= l.bb ? 'bb' : 'each');
  const money = (n) => E.formatMoney(n, S.config.currency);

  function blindsText(l) {
    if (!l) return '—';
    if (E.isBreak(l)) return l.label || 'Break';
    return fmt(l.sb) + ' / ' + fmt(l.bb);
  }

  function anteText(l) {
    if (!l || E.isBreak(l)) return '';
    if (!(l.ante > 0)) return 'No ante';
    return (l.ante === l.bb ? 'BB ante ' : 'Ante ') + fmt(l.ante);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setText(el, v) {
    if (el && el.textContent !== v) el.textContent = v;
  }

  // ---------------------------------------------------------------- Toast & modal

  function toast(msg, ms) {
    const t = $('toast');
    t.innerHTML = msg;
    t.hidden = false;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }

  function openModal(html, bind) {
    $('modalBody').innerHTML = html;
    $('modal').hidden = false;
    if (bind) bind($('modalBody'));
    const first = $('modalBody').querySelector('input, button');
    if (first) first.focus();
  }

  function closeModal() {
    $('modal').hidden = true;
    $('modalBody').innerHTML = '';
  }

  function confirmModal(title, text, okLabel, onOk, danger) {
    openModal(
      `<h3>${esc(title)}</h3><p class="muted">${text}</p>
       <div class="row-actions"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button>
       <button class="btn btn-ghost" data-cancel>Cancel</button></div>`,
      (root) => {
        root.querySelector('[data-ok]').onclick = () => { closeModal(); onOk(); };
        root.querySelector('[data-cancel]').onclick = closeModal;
      }
    );
  }

  // ---------------------------------------------------------------- Clock

  /** Keep one level queued after the current one so the clock never runs dry. */
  function ensureNextLevel() {
    if (cfg().autoExtend === false || S.clock.index < levels().length - 1) return false;
    levels().push(E.extendLevel(levels(), chipValues()));
    renderStructure();
    return true;
  }

  function tick() {
    const now = Date.now();
    if (S.clock.running && ensureNextLevel()) save();
    const res = E.tickClock(S.clock, levels(), now, warnings());
    S.clock = res.clock;
    if (res.events.length) {
      handleClockEvents(res.events, now);
      save();
    }
    renderClock(now);
  }

  function handleClockEvents(events, now) {
    const levelEvents = events.filter((e) => e.type === 'level');
    if (levelEvents.length) {
      let last = levelEvents[levelEvents.length - 1];
      ui.banner = null;
      const breakEnd = levelEvents.find((e) => E.isBreak(levels()[e.from]) && !E.isBreak(levels()[e.index]));
      if (breakEnd && cfg().pauseAfterBreak) {
        // Hold at the start of the first level after the break (even when catching up after sleep).
        S.clock = E.gotoLevel(E.pauseClock(S.clock, now), levels(), breakEnd.index, now, warnings());
        last = breakEnd;
        releaseWakeLock();
        toast('Break is over — press <b>Start</b> when everyone is back', 6000);
      }
      announceLevel(last.index);
      renderStructure();
      renderTable();
    }
    const warn = events.find((e) => e.type === 'warning');
    if (warn) announceWarning(warn.ms);
    if (events.some((e) => e.type === 'finished')) {
      showOverlay('end', 'THAT’S THE STRUCTURE', 'FINAL LEVEL', '', 'Add more levels under Blinds & Breaks to keep playing.', 8000);
      releaseWakeLock();
      renderPlayButton();
    }
  }

  function announceLevel(index) {
    const l = levels()[index];
    const next = levels()[index + 1];
    const sound = cfg().sound;
    if (E.isBreak(l)) {
      const colorUp = colorUpAt(index);
      const sub = [l.minutes + ' minute break', colorUp.length ? 'Color up: ' + colorUp.map((v) => fmt(v)).join(', ') + ' chips' : '']
        .filter(Boolean).join(' · ');
      showOverlay('break', 'TAKE A BREAK', (l.label || 'Break').toUpperCase(), E.formatClock(E.levelMs(l)), sub, 7000);
      const dur = playCue('breakStart');
      speak(`Time for a ${l.minutes} minute break.` + (colorUp.length ? ` Please color up the ${colorUp.join(' and ')} chips.` : ''), dur);
      notify('Break time', `${l.minutes} minute break`);
      return;
    }
    const num = E.levelNumber(levels(), index);
    const sub = [anteText(l), next ? 'Next: ' + blindsText(next) : 'Final level'].filter(Boolean).join(' · ');
    showOverlay('level', 'BLINDS UP', 'LEVEL ' + num, blindsText(l), sub, 7000);
    const dur = playCue('levelUp');
    let text = `Level ${num}. Blinds are now ${l.sb} and ${l.bb}.`;
    if (l.ante > 0) text += l.ante === l.bb ? ` Big blind ante, ${l.ante}.` : ` Ante ${l.ante}.`;
    speak(text, dur);
    notify('Blinds up — Level ' + num, blindsText(l) + (l.ante ? ' · ' + anteText(l) : ''));
    void sound;
  }

  function announceWarning(ms) {
    const idx = S.clock.index;
    const cur = levels()[idx];
    const next = levels()[idx + 1];
    ui.banner = { index: idx, dismissed: false };
    playCue('warning');
    const unit = spokenDuration(ms);
    let text;
    if (E.isBreak(cur)) text = `The break ends in ${unit}.`;
    else if (E.isBreak(next)) text = `Break in ${unit}.`;
    else text = `Blinds go up in ${unit}.`;
    speak(text, 2.2);
    notify(text, next ? 'Next: ' + blindsText(next) : '');
    renderBanner(Date.now());
  }

  /** True when a warning shorter than the level has been crossed (i.e. the banner should show). */
  function realWarningCrossed(rem) {
    const len = E.levelMs(curLevel());
    return S.clock.index < levels().length - 1 && warnings().some((w) => w < len && rem <= w);
  }

  function spokenDuration(ms) {
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    const parts = [];
    if (m) parts.push(m === 1 ? 'one minute' : m + ' minutes');
    if (sec) parts.push(sec + ' seconds');
    return parts.join(' and ') || 'a moment';
  }

  function playCue(cue) {
    const s = cfg().sound;
    if (!s.enabled) return 0;
    return A.play(s[cue] || 'chime', cue) || 0;
  }

  function speak(text, delaySec) {
    const s = cfg().sound;
    if (!s.enabled || !s.voice) return;
    A.say(text, s.voiceName, (delaySec || 0) + 0.2);
  }

  function notify(title, body) {
    if (!cfg().sound.notifications || !document.hidden) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: 'tholdem', renotify: true }); } catch (e) { /* ignore */ }
  }

  function startPause() {
    const now = Date.now();
    A.ensure();
    if (S.clock.finished) {
      toast('The structure is finished — add levels under <b>Blinds &amp; Breaks</b>.');
      return;
    }
    if (S.clock.running) {
      S.clock = E.pauseClock(S.clock, now);
      releaseWakeLock();
    } else {
      S.clock = E.startClock(S.clock, now);
      requestWakeLock();
    }
    save();
    renderClock(now);
  }

  function gotoLevel(index) {
    const now = Date.now();
    const i = E.clampInt(index, 0, levels().length - 1);
    if (i === S.clock.index && !S.clock.finished) return;
    S.clock = E.gotoLevel(S.clock, levels(), i, now, warnings());
    ui.banner = null;
    save();
    renderAll();
  }

  function adjustTime(deltaMs) {
    const now = Date.now();
    S.clock = E.adjustClock(S.clock, deltaMs, now);
    if (ui.banner && E.getRemaining(S.clock, now) > Math.max(...warnings(), 0)) ui.banner = null;
    save();
    renderClock(now);
  }

  function resetLevel() {
    const now = Date.now();
    S.clock = E.gotoLevel({ ...S.clock }, levels(), S.clock.index, now, warnings());
    ui.banner = null;
    save();
    renderClock(now);
  }

  function elapsedMs(now) {
    let ms = 0;
    for (let i = 0; i < S.clock.index; i++) ms += E.levelMs(levels()[i]);
    const len = E.levelMs(curLevel());
    ms += Math.max(0, len - E.getRemaining(S.clock, now));
    return ms;
  }

  // ---------------------------------------------------------------- Wake lock & fullscreen

  async function requestWakeLock() {
    if (!cfg().keepAwake || !('wakeLock' in navigator) || ui.wakeLock) return;
    try {
      ui.wakeLock = await navigator.wakeLock.request('screen');
      ui.wakeLock.addEventListener('release', () => { ui.wakeLock = null; });
    } catch (e) { /* not allowed */ }
  }

  function releaseWakeLock() {
    if (ui.wakeLock) { ui.wakeLock.release().catch(() => {}); ui.wakeLock = null; }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen && document.exitFullscreen();
  }

  function toggleBigClock() {
    cfg().bigClock = !cfg().bigClock;
    save();
    applyBigClock();
    if (cfg().bigClock) showView('table');
  }

  function applyBigClock() {
    document.body.classList.toggle('mode-bigclock', !!cfg().bigClock);
    setText($('bigClockBtn'), cfg().bigClock ? '🂠 Table view' : '⏱ Big clock');
    renderClock();
  }

  function renderBigClock(now, rem) {
    if (!cfg().bigClock) return;
    const idx = S.clock.index;
    const l = curLevel();
    const next = levels()[idx + 1];
    const onBreak = E.isBreak(l);
    setText($('bcLevel'), onBreak ? (l.label || 'Break').toUpperCase() : 'LEVEL ' + E.levelNumber(levels(), idx));
    setText($('bcTime'), E.formatClock(rem));
    setText($('bcBlinds'), onBreak ? 'On break' : blindsText(l));
    setText($('bcAnte'), onBreak ? (next ? 'Next: ' + blindsText(next) : '') : anteText(l));
    setText($('bcNext'), next ? (E.isBreak(next) ? 'Break (' + next.minutes + ' min)' : blindsText(next) + (next.ante ? ' · ' + anteText(next) : '')) : '—');
    const nb = E.msUntilNextBreak(levels(), idx, rem);
    setText($('bcBreak'), onBreak ? 'Now' : nb < 0 ? '—' : E.formatClock(nb));
    const act = E.activePlayers(S.game);
    setText($('bcPlayers'), act.length + ' / ' + S.game.players.length);
    setText($('bcAvg'), fmt(act.length ? totalChips() / act.length : 0));
    setText($('bcState'), S.clock.running ? '' : S.clock.startedAt ? 'PAUSED' : 'PRESS START');
    const bc = $('bigClock');
    const warnMax = Math.max(0, ...warnings());
    bc.classList.toggle('warn', !onBreak && !!next && rem <= warnMax && rem > 60000);
    bc.classList.toggle('danger', !onBreak && !!next && rem <= 60000);
    bc.classList.toggle('on-break', onBreak);
    bc.classList.toggle('paused', !S.clock.running);
  }

  // ---------------------------------------------------------------- Overlay & banner

  function showOverlay(kind, kicker, title, blinds, sub, ms) {
    const o = $('overlay');
    o.className = 'overlay ' + kind;
    setText($('overlayKicker'), kicker);
    setText($('overlayTitle'), title);
    setText($('overlayBlinds'), blinds || '');
    setText($('overlaySub'), sub || '');
    // Restart CSS animations.
    o.hidden = true;
    void o.offsetWidth;
    o.hidden = false;
    clearTimeout(ui.overlayTimer);
    ui.overlayTimer = setTimeout(hideOverlay, ms || 6000);
  }

  function hideOverlay() {
    $('overlay').hidden = true;
    clearTimeout(ui.overlayTimer);
  }

  function renderBanner(now) {
    const b = $('warningBanner');
    const idx = S.clock.index;
    if (!ui.banner || ui.banner.index !== idx || ui.banner.dismissed || S.clock.finished || idx >= levels().length - 1) {
      b.hidden = true;
      return;
    }
    const rem = E.getRemaining(S.clock, now);
    const cur = levels()[idx];
    const next = levels()[idx + 1];
    let text;
    if (E.isBreak(cur)) text = `Break ends in ${E.formatClock(rem)} — next ${blindsText(next)}`;
    else if (E.isBreak(next)) text = `Break in ${E.formatClock(rem)}`;
    else text = `Blinds go up in ${E.formatClock(rem)} — next ${blindsText(next)}` + (next.ante ? ` (${anteText(next)})` : '');
    setText($('warningText'), text);
    b.classList.toggle('urgent', rem <= 60000 && !E.isBreak(cur));
    b.classList.toggle('info', E.isBreak(cur) || E.isBreak(next));
    b.hidden = false;
  }

  // ---------------------------------------------------------------- Rendering: clock & side panels

  function renderPlayButton() {
    const btn = $('playPause');
    setText(btn, S.clock.running ? '❚❚ Pause' : S.clock.finished ? '■ Finished' : '▶ Start');
    btn.classList.toggle('btn-primary', !S.clock.running);
    btn.classList.toggle('btn-gold', S.clock.running);
  }

  function renderClock(now) {
    now = now || Date.now();
    const l = curLevel();
    const idx = S.clock.index;
    const rem = E.getRemaining(S.clock, now);
    const len = E.levelMs(l) || 1;
    const onBreak = E.isBreak(l);
    const next = levels()[idx + 1];
    const warnMax = Math.max(0, ...warnings());

    setText($('clockTime'), E.formatClock(rem));
    setText($('clockLevel'), onBreak ? (l.label || 'BREAK').toUpperCase() : 'LEVEL ' + E.levelNumber(levels(), idx));
    setText($('clockBlinds'), onBreak ? (next ? 'Next ' + blindsText(next) : '') : blindsText(l) + (l.ante ? '  (' + fmt(l.ante) + ')' : ''));
    let state;
    if (S.clock.finished) state = 'Structure complete';
    else if (!S.clock.running) state = S.clock.startedAt ? 'Paused' : 'Press start';
    else state = onBreak ? 'On break' : 'Running';
    setText($('clockState'), state);

    const cc = $('centerClock');
    cc.classList.toggle('paused', !S.clock.running);
    cc.classList.toggle('on-break', onBreak);
    cc.classList.toggle('warn', !onBreak && rem <= warnMax && rem > 60000 && !!next);
    cc.classList.toggle('danger', !onBreak && rem <= 60000 && !!next && S.clock.running);
    const frac = Math.max(0, Math.min(1, rem / len));
    $('ringFg').style.strokeDashoffset = String(339.3 * (1 - frac));

    // Side panel
    setText($('levelLabel'), onBreak ? 'On break' : 'Level ' + E.levelNumber(levels(), idx));
    setText($('blindsNow'), blindsText(l));
    setText($('anteNow'), onBreak ? E.formatClock(rem) + ' left' : anteText(l));
    setText($('blindsNext'), next ? blindsText(next) : 'Final level');
    setText($('anteNext'), next && !E.isBreak(next) ? anteText(next) : next ? next.minutes + ' min' : '');
    const nb = E.msUntilNextBreak(levels(), idx, rem);
    setText($('nextBreak'), onBreak ? 'Now' : nb < 0 ? 'None scheduled' : E.formatClock(nb));
    setText($('elapsed'), E.formatClock(elapsedMs(now)));

    renderPlayButton();
    renderBanner(now);
    renderBigClock(now, rem);
    document.title = `${E.formatClock(rem)} · ${onBreak ? 'Break' : blindsText(l)} — THoldem`;

    if (ui.lastIndex !== idx) {
      ui.lastIndex = idx;
      renderSeatsOnly();
      highlightStructureRow();
    }
  }

  function renderStats() {
    const g = S.game;
    const act = E.activePlayers(g);
    setText($('playersLeft'), act.length + ' / ' + g.players.length);
    const total = totalChips();
    const avg = act.length ? total / act.length : 0;
    setText($('avgStack'), fmt(avg));
    const l = curLevel();
    const bb = !E.isBreak(l) ? l.bb : (levels().slice(S.clock.index).find((x) => !E.isBreak(x)) || {}).bb;
    setText($('avgBb'), bb ? fmt(Math.round(avg / bb)) + ' big blinds' : '');
    setText($('chipsInPlay'), fmt(total));
    const pool = E.prizePool(cfg(), g.players);
    setText($('prizePool'), money(pool.net));
    const pays = E.payouts(pool.net, cfg().payoutPercents);
    $('payoutList').innerHTML = pays.map((p) => `<li>${esc(money(p))}</li>`).join('');
  }

  // ---------------------------------------------------------------- Rendering: table

  function seatGeometry(n) {
    const mobile = window.matchMedia('(max-width: 800px)').matches;
    const rx = mobile ? 41 : 45;
    const ry = mobile ? 43 : 42;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
      out.push({ x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) });
    }
    return out;
  }

  function toward(p, f) {
    return { x: p.x + (50 - p.x) * f, y: p.y + (50 - p.y) * f };
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function chipColor(value) {
    const c = cfg().chips.find((x) => Number(x.value) === Number(value));
    return c ? c.color : '#888';
  }

  function isLight(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 170;
  }

  /** Break an amount into side-view chip stacks (largest denominations first). */
  function stacksHtml(amount, maxStacks, maxPerStack) {
    const vals = cfg().chips.map((c) => Number(c.value)).filter((v) => v > 0).sort((a, b) => b - a);
    let rem = Math.round(amount);
    const stacks = [];
    for (const v of vals) {
      const n = Math.floor(rem / v);
      if (n > 0) { stacks.push({ v, n }); rem -= n * v; }
    }
    if (rem > 0 && vals.length) stacks.push({ v: vals[vals.length - 1], n: 1 });
    return stacks.slice(0, maxStacks).map((s) => {
      const count = Math.min(maxPerStack, s.n);
      let chips = '';
      for (let i = 0; i < count; i++) chips += `<div class="chip-side" style="--c:${chipColor(s.v)}"></div>`;
      return `<div class="stack" title="${s.n} × ${fmt(s.v)}">${chips}</div>`;
    }).join('');
  }

  function renderSeatsOnly() {
    const g = S.game;
    const n = g.players.length;
    const geo = seatGeometry(n);
    const track = cfg().trackStacks;
    const { sbSeat, bbSeat } = E.blindSeats(g);
    const l = curLevel();
    const bb = !E.isBreak(l) ? l.bb : 0;
    let html = '';
    g.players.forEach((p) => {
      const pos = geo[p.seat];
      const cls = ['seat'];
      if (p.out) cls.push('out');
      else if (p.folded && g.handNumber > 0) cls.push('folded');
      if (ui.selected === p.id && !ui.awardMode) cls.push('selected');
      if (ui.awardMode && ui.awardPicks.has(p.id)) cls.push('award-pick');
      const badges = [];
      if (track && !p.out && p.seat === sbSeat) badges.push('<span class="badge sb">SB</span>');
      if (track && !p.out && p.seat === bbSeat) badges.push('<span class="badge bb">BB</span>');
      const stackLine = track ? `<div class="seat-stack">${esc(fmt(p.stack))}</div>` + (bb && !p.out ? `<div class="seat-stack bb">${esc(fmt(Math.floor(p.stack / bb)))} BB</div>` : '') : '';
      html += `<div class="${cls.join(' ')}" data-id="${esc(p.id)}" title="${esc(p.name)} — ${track ? 'tap to select, tap again for the player menu' : 'tap for rebuy, add-on or knockout'}" style="left:${pos.x}%;top:${pos.y}%">
        <div class="seat-card">
          <div class="seat-badges">${badges.join('')}</div>
          <div class="seat-avatar" title="Seat ${p.seat + 1}">${p.seat + 1}</div>
          <div class="seat-name" title="${esc(p.name)}">${esc(p.name)}</div>
          ${stackLine}
        </div>
      </div>`;
      if (track && p.bet > 0) {
        // Bets sit between the seat and the clock; closer to the rail at the top & bottom.
        const ang = Math.atan2(pos.y - 50, pos.x - 50);
        const bp = toward(pos, 0.28 + 0.08 * Math.abs(Math.cos(ang)));
        html += `<div class="seat-bet" style="left:${bp.x}%;top:${bp.y}%">${stacksHtml(p.bet, 3, 6)}<span class="amt">${esc(fmt(p.bet))}</span></div>`;
      }
    });
    const dealer = g.players.find((p) => p.seat === g.dealerSeat);
    if (dealer && n > 1 && track) {
      const dp = geo[dealer.seat];
      const base = toward(dp, 0.26);
      // Nudge the button sideways so it doesn't sit on top of the bet.
      const ang = Math.atan2(dp.y - 50, dp.x - 50) + Math.PI / 2;
      html += `<div class="dealer-btn" style="left:${base.x + Math.cos(ang) * 5}%;top:${base.y + Math.sin(ang) * 6}%">D</div>`;
    }
    $('seats').innerHTML = html;
    $('seats').classList.toggle('dense', n > 8);
  }

  function renderPot(bump) {
    const total = E.potTotal(S.game);
    setText($('potValue'), fmt(total));
    $('potChips').innerHTML = stacksHtml(S.game.pot, 6, 12);
    const area = $('potArea');
    area.hidden = !cfg().trackStacks;
    if (bump) {
      area.classList.remove('bump');
      void area.offsetWidth;
      area.classList.add('bump');
    }
  }

  function renderHandControls() {
    const hc = $('handControls');
    hc.hidden = !cfg().trackStacks;
    const g = S.game;
    const sel = g.players.find((p) => p.id === ui.selected && !p.out);
    setText($('handNo'), g.handNumber ? 'Hand #' + g.handNumber : 'No hand yet');
    const info = $('selectedInfo');
    if (ui.awardMode) {
      const names = g.players.filter((p) => ui.awardPicks.has(p.id)).map((p) => p.name);
      const side = S.game.lastAward && S.game.lastAward.sidePot > 0 && S.game.pot === S.game.lastAward.sidePot;
      info.innerHTML = names.length
        ? `Winner${names.length > 1 ? 's (split)' : ''}: <b>${esc(names.join(', '))}</b> — press Confirm`
        : side ? `Side pot <b>${esc(fmt(S.game.pot))}</b>: tap its winner, then Confirm` : 'Tap the <b>best hand</b> first (all-ins win the main pot), then Confirm — tap several to split';
    } else if (sel) {
      const toCall = Math.max(0, ...g.players.map((p) => p.bet)) - sel.bet;
      info.innerHTML = `<b>${esc(sel.name)}</b> · stack ${esc(fmt(sel.stack))}` + (toCall > 0 ? ` · to call ${esc(fmt(Math.min(toCall, sel.stack)))}` : '') + (sel.folded ? ' · folded' : '') + ' <span class="muted">· tap again for rebuy / knockout · Esc to deselect</span>';
    } else {
      info.textContent = 'Tap a seat to select a player, then build a bet with the chips';
    }
    const can = !!sel && !sel.folded && !ui.awardMode;
    const toCall = sel ? Math.max(0, ...g.players.map((p) => p.bet)) - sel.bet : 0;
    $('callBtn').disabled = !can || sel.stack <= 0;
    setText($('callBtn'), toCall > 0 ? 'Call ' + fmt(Math.min(toCall, sel ? sel.stack : 0)) : 'Check');
    $('foldBtn').disabled = !can;
    $('allInBtn').disabled = !can || sel.stack <= 0;
    $('betPlace').disabled = ui.awardMode;
    $('betPlace').disabled = !can;
    setText($('awardBtn'), ui.awardMode ? '✓ Confirm award' : '🏆 Award pot');
    $('undoBtn').disabled = !ui.undo.length;
    $('cancelAward').hidden = !ui.awardMode;
  }

  function renderChipTray() {
    const chips = cfg().chips.slice().sort((a, b) => a.value - b.value);
    $('chipTray').innerHTML = chips.map((c) =>
      `<button class="chip${isLight(c.color) ? ' light' : ''}" style="--c:${esc(c.color)}" data-v="${esc(c.value)}" title="Add ${esc(fmt(c.value))}"><span>${esc(E.formatChips(c.value, true))}</span></button>`
    ).join('');
  }

  function renderTable() {
    renderSeatsOnly();
    renderPot();
    renderHandControls();
    renderStats();
  }

  function renderTheme() {
    document.body.dataset.felt = cfg().theme.felt;
    document.body.dataset.rail = cfg().theme.rail;
    setText($('feltBrand'), cfg().theme.feltText != null ? cfg().theme.feltText : 'THoldem');
    setText($('eventTitle'), cfg().eventName || '');
    $('muteBtn').textContent = cfg().sound.enabled ? '🔊' : '🔇';
    $('muteBtn').classList.toggle('off', !cfg().sound.enabled);
  }

  // ---------------------------------------------------------------- Hand / pot actions

  function pushUndo() {
    ui.undo.push(JSON.stringify(S.game));
    if (ui.undo.length > 40) ui.undo.shift();
  }

  function undo() {
    const prev = ui.undo.pop();
    if (!prev) return;
    S.game = JSON.parse(prev);
    // The table may have been resized or renamed since: keep the config in step.
    cfg().playerCount = S.game.players.length;
    S.game.players.forEach((p) => { cfg().playerNames[p.seat] = p.name; });
    if (ui.selected && !S.game.players.some((p) => p.id === ui.selected)) ui.selected = null;
    exitAwardMode();
    save();
    renderTable();
    toast('Undone');
  }

  function commitGame(game, bump) {
    S.game = game;
    save();
    renderSeatsOnly();
    renderPot(bump);
    renderHandControls();
    renderStats();
  }

  function selectNextToAct(fromId) {
    const g = S.game;
    const from = g.players.find((p) => p.id === fromId);
    if (!from) return;
    const n = Math.max(...g.players.map((p) => p.seat)) + 1;
    const cand = g.players
      .filter((p) => !p.out && !p.folded && p.stack > 0 && p.id !== fromId)
      .sort((a, b) => ((a.seat - from.seat + n) % n) - ((b.seat - from.seat + n) % n));
    ui.selected = cand.length ? cand[0].id : null;
  }

  function liveInHand() {
    return S.game.players.filter((p) => !p.out && !p.folded);
  }

  function newHand() {
    if (!cfg().trackStacks) return;
    exitAwardMode();
    const carried = E.potTotal(S.game);
    const l = curLevel();
    if (E.activePlayers(S.game).length < 2) { toast('Need at least two players still in.'); return; }
    pushUndo();
    const g = E.startHand(S.game, l, anteModeFor(l));
    const bs = g.lastBlinds;
    if (bs) {
      const bbSeat = bs.bbSeat;
      const utg = E.nextActiveSeat(g, bbSeat);
      const p = g.players.find((x) => x.seat === utg);
      ui.selected = p ? p.id : null;
    }
    commitGame(g, true);
    const dealer = g.players.find((p) => p.seat === g.dealerSeat);
    let msg = `Hand #${g.handNumber} — ${esc(dealer ? dealer.name : '')} has the button`;
    if (E.isBreak(l)) msg += ' (on break: no blinds posted)';
    if (carried > 0) msg += ` · ${esc(fmt(carried))} carried into the pot`;
    toast(msg);
  }

  function selectedPlayer() {
    return S.game.players.find((p) => p.id === ui.selected && !p.out);
  }

  /** The selected player, if they can still act this hand. */
  function actingPlayer() {
    const p = selectedPlayer();
    return p && !p.folded && !ui.awardMode ? p : null;
  }

  function betAmount() {
    return Math.max(0, Math.round(Number($('betAmount').value) || 0));
  }

  function placeBet(amount) {
    const p = selectedPlayer();
    if (!amount || ui.awardMode) return;
    if (p && p.folded) { toast(`${esc(p.name)} has folded — Esc to deselect, then Add to pot`); return; }
    if (!p) {
      toast('Tap the seat of the player putting chips in first');
      return;
    }
    pushUndo();
    {
      const res = E.placeBet(S.game, p.id, amount);
      S.game = res.game;
      selectNextToAct(p.id);
      commitGame(S.game, true);
      if (res.amount < amount) toast(`${esc(p.name)} is all-in for ${esc(fmt(res.amount))}`);
    }
    $('betAmount').value = '';
  }

  function call() {
    const p = actingPlayer();
    if (!p) return;
    pushUndo();
    const res = E.callBet(S.game, p.id);
    S.game = res.game;
    selectNextToAct(p.id);
    commitGame(S.game, res.amount > 0);
  }

  function allIn() {
    const p = actingPlayer();
    if (!p || p.stack <= 0) return;
    pushUndo();
    const res = E.placeBet(S.game, p.id, p.stack);
    S.game = res.game;
    selectNextToAct(p.id);
    commitGame(S.game, true);
    toast(`${esc(p.name)} is ALL-IN`);
  }

  function foldSelected() {
    const p = actingPlayer();
    if (!p) return;
    pushUndo();
    S.game = E.fold(S.game, p.id);
    selectNextToAct(p.id);
    const live = liveInHand();
    if (live.length === 1 && E.potTotal(S.game) > 0) {
      const w = live[0];
      const amt = E.potTotal(S.game);
      S.game = E.awardPot(S.game, [w.id], smallestChip());
      ui.selected = null;
      commitGame(S.game, true);
      flashWinners([w.id]);
      toast(`<b>${esc(w.name)}</b> wins ${esc(fmt(amt))} — everyone else folded`);
      return;
    }
    commitGame(S.game);
  }

  function collect() {
    if (!S.game.players.some((p) => p.bet > 0)) return;
    pushUndo();
    commitGame(E.collectBets(S.game), true);
  }

  function toggleAward() {
    if (!ui.awardMode) {
      if (E.potTotal(S.game) <= 0) { toast('The pot is empty.'); return; }
      const live = liveInHand();
      if (live.length === 1) { awardTo([live[0].id]); return; }
      ui.awardMode = true;
      ui.awardPicks = new Set();
      renderSeatsOnly();
      renderHandControls();
      return;
    }
    if (!ui.awardPicks.size) { toast('Tap the winning seat(s) first.'); return; }
    awardTo([...ui.awardPicks]);
  }

  function exitAwardMode() {
    ui.awardMode = false;
    ui.awardPicks = new Set();
  }

  function awardTo(ids) {
    pushUndo();
    S.game = E.awardPot(S.game, ids, smallestChip());
    const res = S.game.lastAward || { won: 0, sidePot: 0, returned: 0 };
    exitAwardMode();
    ui.selected = null;
    const names = S.game.players.filter((p) => ids.includes(p.id)).map((p) => p.name);
    let msg = `<b>${esc(names.join(' & '))}</b> ${names.length > 1 ? 'split' : 'wins'} ${esc(fmt(res.won))}`;
    if (res.returned) msg += ` · ${esc(fmt(res.returned))} uncalled/side pot returned`;
    if (res.sidePot > 0) {
      // A short-stacked winner can't win it all: keep awarding the side pot.
      ui.awardMode = true;
      ui.awardPicks = new Set();
      msg += ` · <b>side pot ${esc(fmt(res.sidePot))}</b> left — tap its winner`;
    }
    commitGame(S.game, true);
    flashWinners(ids);
    toast(msg, res.sidePot > 0 ? 5000 : 2600);
    if (res.sidePot > 0) return;
    const busted = S.game.players.filter((p) => !p.out && p.stack === 0 && p.bet === 0);
    if (busted.length) setTimeout(() => promptBust(busted), 700);
  }

  function flashWinners(ids) {
    ids.forEach((id) => {
      const el = document.querySelector(`.seat[data-id="${CSS.escape(id)}"]`);
      if (el) el.classList.add('winner');
    });
  }

  function promptBust(players) {
    const p = players[0];
    const place = E.activePlayers(S.game).length;
    openModal(
      `<h3>${esc(p.name)} is out of chips</h3>
       <p class="muted">Knock them out in <b>${ordinal(place)}</b> place, or rebuy for ${esc(money(cfg().rebuyCost))} (${esc(fmt(cfg().rebuyChips))} chips)?</p>
       <div class="row-actions">
         <button class="btn btn-danger" data-bust>Knock out</button>
         <button class="btn btn-primary" data-rebuy>Rebuy</button>
         <button class="btn btn-ghost" data-later>Later</button>
       </div>`,
      (root) => {
        const nextUp = () => {
          const rest = players.slice(1).filter((q) => { const cur = S.game.players.find((x) => x.id === q.id); return cur && !cur.out && cur.stack === 0; });
          if (rest.length) setTimeout(() => promptBust(rest), 200);
        };
        root.querySelector('[data-bust]').onclick = () => { closeModal(); knockOut(p.id); nextUp(); };
        root.querySelector('[data-rebuy]').onclick = () => { closeModal(); doRebuy(p.id); nextUp(); };
        root.querySelector('[data-later]').onclick = () => { closeModal(); nextUp(); };
      }
    );
  }

  function knockOut(id) {
    pushUndo();
    const p = S.game.players.find((x) => x.id === id);
    S.game = E.eliminate(S.game, id);
    if (ui.selected === id) ui.selected = null;
    commitGame(S.game);
    const left = E.activePlayers(S.game);
    if (left.length === 1) {
      S.clock = E.pauseClock(S.clock, Date.now());
      releaseWakeLock();
      save();
      showOverlay('level', 'WE HAVE A CHAMPION', left[0].name.toUpperCase(), '🏆', `${cfg().eventName || ''}`, 12000);
      playCue('levelUp');
      speak(`Congratulations ${left[0].name}, champion of ${cfg().eventName || 'the tournament'}!`, 3);
    } else {
      toast(`${esc(p ? p.name : 'Player')} finishes ${ordinal(S.game.players.find((x) => x.id === id).place)}`);
    }
  }

  function doRebuy(id) {
    pushUndo();
    const p = S.game.players.find((x) => x.id === id);
    S.game = E.rebuy(S.game, id, cfg().rebuyChips);
    commitGame(S.game);
    toast(`${esc(p ? p.name : 'Player')} rebuys for ${esc(fmt(cfg().rebuyChips))}`);
  }

  function doAddon(id) {
    pushUndo();
    const p = S.game.players.find((x) => x.id === id);
    S.game = E.addon(S.game, id, cfg().addonChips);
    commitGame(S.game);
    toast(`${esc(p ? p.name : 'Player')} takes the add-on (+${esc(fmt(cfg().addonChips))})`);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function openPlayerModal(id) {
    const p = S.game.players.find((x) => x.id === id);
    if (!p) return;
    const c = cfg();
    openModal(
      `<h3>Seat ${p.seat + 1}</h3>
       <div class="form-grid">
         <label>Name<input type="text" data-f="name" value="${esc(p.name)}" maxlength="24" /></label>
         <label>Stack<input type="number" data-f="stack" value="${p.stack}" min="0" /></label>
       </div>
       <div class="stat-line"><span class="muted">Rebuys</span><b>${p.rebuys}</b></div>
       <div class="stat-line"><span class="muted">Add-ons</span><b>${p.addons}</b></div>
       ${p.out ? `<div class="stat-line"><span class="muted">Finished</span><b>${ordinal(p.place)}</b></div>` : ''}
       <div class="row-actions">
         <button class="btn btn-primary" data-save>Save</button>
         <button class="btn" data-dealer>Give button</button>
         <button class="btn" data-rebuy>Rebuy (+${esc(fmt(c.rebuyChips))})</button>
         <button class="btn" data-addon ${p.out ? 'disabled' : ''}>Add-on (+${esc(fmt(c.addonChips))})</button>
         ${p.out ? '<button class="btn" data-back title="Returns with 0 chips — set their stack, then Save">Bring back</button>' : '<button class="btn btn-danger" data-bust>Knock out</button>'}
       </div>
       ${p.out ? '<p class="muted">Bring back returns them with 0 chips — then set their stack and Save.</p>' : ''}`,
      (root) => {
        const nameIn = root.querySelector('[data-f=name]');
        const stackIn = root.querySelector('[data-f=stack]');
        const saveEdits = () => {
          const name = nameIn.value.trim() || p.name;
          const stack = Math.max(0, Math.round(Number(stackIn.value) || 0));
          if (name === p.name && stack === p.stack) return;
          pushUndo();
          const g = JSON.parse(JSON.stringify(S.game));
          const q = g.players.find((x) => x.id === id);
          q.name = name;
          q.stack = stack;
          c.playerNames[q.seat] = name;
          commitGame(g);
          renderPlayersView();
        };
        root.querySelector('[data-save]').onclick = () => { saveEdits(); closeModal(); };
        root.querySelector('[data-dealer]').onclick = () => { pushUndo(); commitGame({ ...S.game, dealerSeat: p.seat, manualButton: true, lastBlinds: null, players: S.game.players.map((x) => ({ ...x })) }); closeModal(); };
        root.querySelector('[data-rebuy]').onclick = () => { closeModal(); doRebuy(id); };
        const ad = root.querySelector('[data-addon]');
        if (ad) ad.onclick = () => { closeModal(); doAddon(id); };
        const bust = root.querySelector('[data-bust]');
        if (bust) bust.onclick = () => { closeModal(); confirmModal('Knock out ' + p.name + '?', `They finish in <b>${ordinal(E.activePlayers(S.game).length)}</b> place. Chips they have already bet stay in the pot; the rest of their stack leaves play.`, 'Knock out', () => knockOut(id), true); };
        const back = root.querySelector('[data-back]');
        if (back) back.onclick = () => { pushUndo(); commitGame(E.reinstate(S.game, id, 0)); closeModal(); openPlayerModal(id); };
        stackIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saveEdits(); closeModal(); } });
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saveEdits(); closeModal(); } });
      }
    );
  }

  function onSeatClick(e) {
    const seatEl = e.target.closest('.seat');
    if (!seatEl) return;
    e.stopPropagation();
    const id = seatEl.dataset.id;
    const p = S.game.players.find((x) => x.id === id);
    if (!p) return;
    if (!cfg().trackStacks) { openPlayerModal(id); return; }
    if (ui.awardMode) {
      if (p.out) return;
      if (ui.awardPicks.has(id)) ui.awardPicks.delete(id);
      else ui.awardPicks.add(id);
      renderSeatsOnly();
      renderHandControls();
      return;
    }
    if (ui.selected === id || p.out) { openPlayerModal(id); return; }
    ui.selected = id;
    renderSeatsOnly();
    renderHandControls();
  }

  // ---------------------------------------------------------------- Structure view

  function colorUpAt(breakIndex) {
    const vals = cfg().chips.map((c) => Number(c.value));
    const now = E.colorUpCandidates(vals, levels(), breakIndex + 1);
    // Exclude chips that could already have been colored up at an earlier break.
    let prevBreak = -1;
    for (let i = breakIndex - 1; i >= 0; i--) if (E.isBreak(levels()[i])) { prevBreak = i; break; }
    const before = prevBreak >= 0 ? E.colorUpCandidates(vals, levels(), prevBreak + 1) : [];
    return now.filter((v) => !before.includes(v));
  }

  function mutateLevels(fn) {
    const cur = curLevel();
    const oldIndex = S.clock.index;
    fn(levels());
    if (!levels().length) levels().push({ type: 'level', sb: 25, bb: 50, ante: 0, minutes: 15 });
    const ni = levels().indexOf(cur);
    if (ni >= 0) {
      S.clock = { ...S.clock, index: ni };
    } else {
      S.clock = E.gotoLevel(S.clock, levels(), Math.min(oldIndex, levels().length - 1), Date.now(), warnings());
    }
    if (S.clock.finished && S.clock.index < levels().length - 1) {
      S.clock = E.gotoLevel({ ...S.clock, running: false }, levels(), S.clock.index + 1, Date.now(), warnings());
    }
    save();
    renderStructure();
    renderClock();
    renderStats();
    renderChipsView();
  }

  function renderStructure() {
    const body = $('structureBody');
    $('pauseAfterBreak').checked = !!cfg().pauseAfterBreak;
    $('autoExtend').checked = cfg().autoExtend !== false;
    $('anteMode').value = cfg().anteMode || 'auto';
    const ls = levels();
    let startMs = 0;
    let num = 0;
    const rows = ls.map((l, i) => {
      const brk = E.isBreak(l);
      if (!brk) num++;
      const starts = E.formatClock(startMs);
      startMs += E.levelMs(l);
      const cls = [brk ? 'is-break' : '', i === S.clock.index ? 'is-current' : '', i < S.clock.index ? 'is-past' : ''].join(' ');
      const tools = `<div class="row-tools">
          <button class="btn btn-ghost" data-act="go" title="Jump the clock here">▶</button>
          <button class="btn btn-ghost" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-ghost" data-act="down" title="Move down" ${i === ls.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-ghost" data-act="dup" title="Duplicate">⧉</button>
          <button class="btn btn-ghost" data-act="del" title="Delete">✕</button>
        </div>`;
      if (brk) {
        return `<tr class="${cls}" data-i="${i}">
          <td><span class="break-pill">☕</span></td>
          <td><input type="text" data-f="label" value="${esc(l.label || 'Break')}" maxlength="24" /></td>
          <td colspan="3" class="muted">${colorUpAt(i).length ? 'Color up: ' + colorUpAt(i).map((v) => fmt(v)).join(', ') : ''}</td>
          <td><input type="number" data-f="minutes" min="0.5" step="0.5" value="${esc(l.minutes)}" /></td>
          <td class="muted">${starts}</td>
          <td>${tools}</td></tr>`;
      }
      return `<tr class="${cls}" data-i="${i}">
        <td class="lvl-num">${num}</td>
        <td class="muted">Level</td>
        <td><input type="number" data-f="sb" min="0" value="${esc(l.sb)}" /></td>
        <td><input type="number" data-f="bb" min="0" value="${esc(l.bb)}" /></td>
        <td><input type="number" data-f="ante" min="0" value="${esc(l.ante || 0)}" /></td>
        <td><input type="number" data-f="minutes" min="0.5" step="0.5" value="${esc(l.minutes)}" /></td>
        <td class="muted">${starts}</td>
        <td>${tools}</td></tr>`;
    });
    body.innerHTML = rows.join('');
    const probs = E.validateLevels(ls);
    $('structureProblems').innerHTML = probs.length
      ? '⚠ ' + probs.slice(0, 4).map((p) => `Row ${p.index + 1}: ${esc(p.message)}`).join('<br>⚠ ')
      : '';
    const totalLevels = ls.filter((l) => !E.isBreak(l)).length;
    const breaks = ls.length - totalLevels;
    setText($('genSummary'), `${totalLevels} levels · ${breaks} breaks · ${E.formatClock(startMs)} total`);
  }

  function highlightStructureRow() {
    document.querySelectorAll('#structureBody tr').forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.classList.toggle('is-current', i === S.clock.index);
      tr.classList.toggle('is-past', i < S.clock.index);
    });
  }

  /** Re-render an editor after the browser has moved focus (Tab), then put focus back where it went. */
  function rerenderKeepingFocus(render) {
    setTimeout(() => {
      const a = document.activeElement;
      const row = a && a.closest && a.closest('[data-i]');
      const key = row && a.dataset.f ? { i: row.dataset.i, f: a.dataset.f, sel: a.type === 'text' ? [a.selectionStart, a.selectionEnd] : null } : null;
      render();
      if (!key) return;
      const el = document.querySelector(`[data-i="${key.i}"] [data-f="${key.f}"]`);
      if (el) {
        el.focus();
        if (el.select && el.type === 'number') el.select();
      }
    }, 0);
  }

  function onStructureChange(e) {
    const input = e.target.closest('input');
    if (!input) return;
    const i = Number(input.closest('tr').dataset.i);
    const f = input.dataset.f;
    const l = levels()[i];
    if (!l) return;
    if (f === 'label') {
      l.label = input.value.trim() || 'Break';
      save();
      renderClock();
      return;
    }
    let v = Number(input.value);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (f === 'minutes') {
      v = Math.max(0.5, v);
      if (i === S.clock.index) {
        const delta = (v - l.minutes) * E.MINUTE;
        l.minutes = v;
        S.clock = E.adjustClock(S.clock, delta, Date.now());
      } else {
        l.minutes = v;
      }
    } else {
      l[f] = Math.round(v);
      if (f === 'bb' && input.closest('tr').querySelector('[data-f=sb]') && l.sb === 0) l.sb = Math.round(v / 2);
    }
    save();
    rerenderKeepingFocus(renderStructure);
    renderClock();
    renderStats();
    renderSeatsOnly();
  }

  function onStructureClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = Number(btn.closest('tr').dataset.i);
    const act = btn.dataset.act;
    if (act === 'go') { gotoLevel(i); toast('Clock moved to ' + (E.isBreak(levels()[i]) ? 'the break' : 'level ' + E.levelNumber(levels(), i))); return; }
    mutateLevels((ls) => {
      if (act === 'up' && i > 0) [ls[i - 1], ls[i]] = [ls[i], ls[i - 1]];
      if (act === 'down' && i < ls.length - 1) [ls[i + 1], ls[i]] = [ls[i], ls[i + 1]];
      if (act === 'dup') ls.splice(i + 1, 0, { ...ls[i] });
      if (act === 'del') ls.splice(i, 1);
    });
  }

  function addLevel() {
    mutateLevels((ls) => { ls.push(E.extendLevel(ls, chipValues())); });
  }

  function addBreak() {
    mutateLevels((ls) => { ls.push({ type: 'break', minutes: 10, label: 'Break' }); });
  }

  function readGenForm() {
    return {
      startingStack: Math.max(1, Number($('genStack').value) || cfg().startingStack),
      smallestChip: Math.max(1, Number($('genChip').value) || 25),
      startingBigBlinds: Math.max(10, Number($('genDepth').value) || 100),
      levelMinutes: Math.max(0.5, Number($('genMinutes').value) || 15),
      levelCount: E.clampInt($('genCount').value, 1, 60),
      speed: $('genSpeed').value,
      breakEvery: Math.max(0, Number($('genBreakEvery').value) || 0),
      breakMinutes: Math.max(1, Number($('genBreakMinutes').value) || 10),
      antes: $('genAntes').value,
      anteFromLevel: Math.max(1, Number($('genAnteFrom').value) || 1),
      chipValues: chipValues(),
    };
  }

  function fillGenForm(p) {
    $('genStack').value = cfg().startingStack;
    const smallest = Math.min(...cfg().chips.map((c) => Number(c.value)).filter((v) => v > 0));
    $('genChip').value = Number.isFinite(smallest) ? smallest : 25;
    if (!p) return;
    $('genDepth').value = p.startingBigBlinds || 100;
    $('genMinutes').value = p.levelMinutes;
    $('genCount').value = p.levelCount;
    $('genSpeed').value = p.speed;
    $('genBreakEvery').value = p.breakEvery;
    $('genBreakMinutes').value = p.breakMinutes || 10;
    $('genAntes').value = p.antes;
    $('genAnteFrom').value = p.anteFromLevel;
  }

  function generate() {
    const opts = readGenForm();
    const apply = () => {
      cfg().levels = E.generateStructure(opts);
      if (opts.antes !== 'none') cfg().anteMode = opts.antes === 'classic' ? 'each' : 'bb';
      S.clock = E.gotoLevel({ ...S.clock, running: false, endsAt: null }, levels(), 0, Date.now(), warnings());
      S.clock.startedAt = null;
      ui.banner = null;
      releaseWakeLock();
      save();
      renderAll();
      toast('New structure ready — clock reset to level 1');
    };
    if (S.clock.startedAt || S.clock.index > 0) {
      confirmModal('Replace the structure?', 'This replaces every level and resets the clock to level 1 (paused). Players and stacks are not touched.', 'Replace', apply, true);
    } else apply();
  }

  // ---------------------------------------------------------------- Players view

  function renderPlayersView() {
    const c = cfg();
    $('playerCount').value = c.playerCount;
    $('eventName').value = c.eventName;
    $('startingStack').value = c.startingStack;
    $('currency').value = c.currency;
    $('trackStacks').checked = !!c.trackStacks;
    ['buyIn', 'rakePercent', 'rebuyCost', 'rebuyChips', 'addonCost', 'addonChips'].forEach((k) => { $(k).value = c[k]; });
    $('nameGrid').innerHTML = S.game.players.map((p) =>
      `<label>Seat ${p.seat + 1}<input type="text" data-seat="${p.seat}" value="${esc(p.name)}" maxlength="24" /></label>`
    ).join('');
    $('payoutEditor').innerHTML = c.payoutPercents.map((pct, i) =>
      `<label>${ordinal(i + 1)}<input type="number" data-place="${i}" min="0" max="100" step="any" value="${esc(pct)}" /></label>`
    ).join('');
    const sum = c.payoutPercents.reduce((s, x) => s + Number(x || 0), 0);
    const sumEl = $('payoutSum');
    sumEl.textContent = `Total ${Math.round(sum * 100) / 100}%` + (Math.abs(sum - 100) > 0.01 ? ' — should add up to 100%' : ' ✓');
    sumEl.style.color = Math.abs(sum - 100) > 0.01 ? 'var(--amber)' : '';
    renderStandings();
  }

  function renderStandings() {
    const g = S.game;
    const pool = E.prizePool(cfg(), g.players);
    const pays = E.payouts(pool.net, cfg().payoutPercents);
    const act = E.activePlayers(g).sort((a, b) => b.stack - a.stack);
    const out = g.players.filter((p) => p.out).sort((a, b) => a.place - b.place);
    const rows = [...act, ...out].map((p, i) => {
      const place = p.out ? p.place : null;
      const prize = place && pays[place - 1] ? money(pays[place - 1]) : '';
      return `<tr><td>${p.out ? ordinal(place) : i + 1}</td><td>${esc(p.name)}</td><td>${p.out ? '<span class="muted">out</span>' : esc(fmt(p.stack))}</td><td>${p.rebuys || ''}</td><td>${p.addons || ''}</td><td>${esc(prize)}</td></tr>`;
    });
    $('standings').innerHTML = `<h4>Standings · pool ${esc(money(pool.gross))}${pool.rake ? ' − ' + esc(money(pool.rake)) + ' fee' : ''}</h4>
      <table><thead><tr><th>#</th><th>Player</th><th>Chips</th><th>Rebuys</th><th>Add-ons</th><th>Prize</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function onPlayersInput(e) {
    const t = e.target;
    const c = cfg();
    if (t.dataset.seat != null) {
      const seat = Number(t.dataset.seat);
      const name = t.value.trim() || 'Player ' + (seat + 1);
      c.playerNames[seat] = name;
      const p = S.game.players.find((x) => x.seat === seat);
      if (p) p.name = name;
      save();
      renderSeatsOnly();
      return;
    }
    if (t.dataset.place != null) {
      c.payoutPercents[Number(t.dataset.place)] = Math.max(0, Number(t.value) || 0);
      c.payoutsCustom = true;
      save();
      const sum = c.payoutPercents.reduce((s, x) => s + Number(x || 0), 0);
      $('payoutSum').textContent = `Total ${Math.round(sum * 100) / 100}%` + (Math.abs(sum - 100) > 0.01 ? ' — should add up to 100%' : ' ✓');
      $('payoutSum').style.color = Math.abs(sum - 100) > 0.01 ? 'var(--amber)' : '';
      renderStats();
      renderStandings();
      return;
    }
    switch (t.id) {
      case 'eventName': c.eventName = t.value; renderTheme(); break;
      case 'currency': c.currency = t.value; renderStats(); renderStandings(); break;
      case 'buyIn': case 'rakePercent': case 'rebuyCost': case 'addonCost':
        c[t.id] = Math.max(0, Number(t.value) || 0); renderStats(); renderStandings(); break;
      case 'rebuyChips': case 'addonChips':
        c[t.id] = Math.max(0, Math.round(Number(t.value) || 0)); break;
      default: return;
    }
    save();
  }

  function onPlayersChange(e) {
    const t = e.target;
    const c = cfg();
    if (t.id === 'playerCount') {
      const n = E.clampInt(t.value, 2, 12);
      t.value = n;
      if (n === c.playerCount) return;
      for (let i = c.playerNames.length; i < n; i++) c.playerNames[i] = E.PLAYER_NAMES[i] || 'Player ' + (i + 1);
      c.playerCount = n;
      if (!c.payoutsCustom) c.payoutPercents = E.defaultPayoutPercents(n);
      pushUndo();
      S.game = E.resizePlayers(S.game, c);
      ui.selected = null;
      renderHandControls();
      save();
      renderPlayersView();
      renderTable();
      renderChipsView();
    } else if (t.id === 'startingStack') {
      const v = Math.max(1, Math.round(Number(t.value) || 0));
      const old = c.startingStack;
      c.startingStack = v;
      // Before the first hand, stacks follow the starting stack.
      if (S.game.handNumber === 0) S.game.players.forEach((p) => { if (p.stack === old && !p.out) p.stack = v; });
      save();
      renderTable();
      renderChipsView();
      fillGenForm();
      toast('Starting stack is ' + fmt(v) + ' — regenerate the blinds if you want them to match.');
    } else if (t.id === 'trackStacks') {
      setMode(t.checked ? 'full' : 'run');
    }
  }

  /** 'run' = clock only (nothing to click per hand); 'full' = track stacks, bets and the pot. */
  function setMode(mode) {
    const full = mode === 'full';
    if (cfg().trackStacks === full) return;
    cfg().trackStacks = full;
    exitAwardMode();
    ui.selected = null;
    save(true);
    renderTable();
    renderMode();
    $('trackStacks').checked = full;
    toast(full
      ? '<b>Full mode</b>: New hand posts blinds; tap seats to bet, award the pot'
      : '<b>Run mode</b>: just the clock — tap a player only for rebuys or knockouts');
  }

  function renderMode() {
    const full = !!cfg().trackStacks;
    document.body.classList.toggle('mode-run', !full);
    document.querySelectorAll('#modeSwitch [data-mode]').forEach((b) => {
      const on = (b.dataset.mode === 'full') === full;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function shuffleSeats() {
    const c = cfg();
    const names = S.game.players.map((p) => p.name);
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    pushUndo();
    S.game.players.forEach((p, i) => { p.name = names[i]; c.playerNames[p.seat] = names[i]; });
    S.game.dealerSeat = S.game.players[Math.floor(Math.random() * S.game.players.length)].seat;
    save();
    renderPlayersView();
    renderTable();
    toast('Seats shuffled — the button was drawn at random');
  }

  function newTournament() {
    confirmModal('Start a new tournament?', 'Clock back to level 1, all stacks reset, pot cleared, knockouts and rebuys wiped. Your structure and settings stay.', 'Start fresh', () => {
      S.clock = E.createClock(levels(), warnings());
      S.game = E.createGame(cfg());
      ui.selected = null;
      ui.undo = [];
      ui.banner = null;
      exitAwardMode();
      releaseWakeLock();
      save(true);
      renderAll();
      toast('Fresh tournament — shuffle up and deal!');
    }, true);
  }

  // ---------------------------------------------------------------- Chips view

  function renderChipsView() {
    const c = cfg();
    const chips = c.chips;
    $('chipEditor').innerHTML = chips.map((ch, i) =>
      `<div class="chip-row" data-i="${i}">
        <div class="chip${isLight(ch.color) ? ' light' : ''}" style="--c:${esc(ch.color)}"><span>${esc(E.formatChips(ch.value, true))}</span></div>
        <input type="color" data-f="color" value="${esc(ch.color)}" title="Chip color" />
        <label>Value<input type="number" data-f="value" min="1" value="${esc(ch.value)}" /></label>
        <label class="chip-label">Name<input type="text" data-f="label" value="${esc(ch.label || '')}" maxlength="16" /></label>
        <label>Per player<input type="number" data-f="perPlayer" min="0" value="${esc(ch.perPlayer || 0)}" /></label>
        <div class="sub">= ${esc(fmt(ch.value * (ch.perPlayer || 0)))}</div>
        <button class="btn btn-ghost" data-act="del" title="Remove">✕</button>
      </div>`
    ).join('');
    const total = E.stackFromChips(chips);
    const ok = total === c.startingStack;
    $('chipSummary').innerHTML = `Per player: <b>${esc(fmt(total))}</b> ` + (ok ? '✓ matches the starting stack' : `<span style="color:var(--amber)">≠ starting stack ${esc(fmt(c.startingStack))}</span> <button class="btn btn-small" id="useChipTotal">Use ${esc(fmt(total))} as starting stack</button>`);
    const n = c.playerCount;
    $('chipNeeds').innerHTML = chips.slice().sort((a, b) => a.value - b.value).map((ch) =>
      `<div class="chip-needs-row"><div class="chip${isLight(ch.color) ? ' light' : ''}" style="--c:${esc(ch.color)}"><span>${esc(E.formatChips(ch.value, true))}</span></div>
        <div>${esc(ch.label || '')} <span class="muted">${esc(fmt(ch.value))}</span></div>
        <div style="margin-left:auto"><b>${(ch.perPlayer || 0) * n}</b> <span class="muted">chips for ${n} players</span></div></div>`
    ).join('') + `<p class="muted">Keep extra on hand for rebuys (${esc(fmt(c.rebuyChips))}) and add-ons (${esc(fmt(c.addonChips))}).</p>`;

    const brks = levels().map((l, i) => (E.isBreak(l) ? i : -1)).filter((i) => i >= 0);
    const lines = brks.map((bi) => {
      const up = colorUpAt(bi);
      const lvl = E.levelNumber(levels(), bi);
      return `<div class="chip-needs-row"><div>${esc(levels()[bi].label || 'Break')} <span class="muted">after level ${lvl}</span></div>
        <div style="margin-left:auto">${up.length ? up.map((v) => `<span class="chip${isLight(chipColor(v)) ? ' light' : ''}" style="--c:${esc(chipColor(v))};--size:30px;display:inline-grid;vertical-align:middle"><span>${esc(E.formatChips(v, true))}</span></span>`).join(' ') + ' <span class="muted">can be colored up</span>' : '<span class="muted">Nothing to color up</span>'}</div></div>`;
    });
    $('colorUp').innerHTML = lines.length ? lines.join('') : '<p class="muted">Add a break to the structure to plan a color-up.</p>';
    renderChipTray();
  }

  function onChipsChange(e) {
    const t = e.target;
    const row = t.closest('.chip-row');
    if (!row) return;
    const ch = cfg().chips[Number(row.dataset.i)];
    const f = t.dataset.f;
    if (!ch || !f) return;
    if (f === 'color' || f === 'label') ch[f] = t.value;
    else ch[f] = Math.max(f === 'value' ? 1 : 0, Math.round(Number(t.value) || 0));
    if (f === 'value') cfg().chips.sort((a, b) => a.value - b.value);
    save();
    rerenderKeepingFocus(renderChipsView);
    renderPot();
    renderSeatsOnly();
    renderStructure();
  }

  function onChipsClick(e) {
    if (e.target.id === 'useChipTotal') {
      cfg().startingStack = E.stackFromChips(cfg().chips);
      if (S.game.handNumber === 0) S.game.players.forEach((p) => { if (!p.out) p.stack = cfg().startingStack; });
      save();
      renderAll();
      return;
    }
    const btn = e.target.closest('button[data-act=del]');
    if (!btn) return;
    if (cfg().chips.length <= 1) { toast('Keep at least one denomination.'); return; }
    cfg().chips.splice(Number(btn.closest('.chip-row').dataset.i), 1);
    save();
    renderChipsView();
    renderPot();
  }

  function addChip() {
    const chips = cfg().chips;
    const max = Math.max(0, ...chips.map((c) => Number(c.value)));
    const palette = ['#1e5bd8', '#c0392b', '#f2f2f2', '#8e44ad', '#16a085', '#7f8c8d', '#e67e22'];
    chips.push({ value: max ? max * 5 : 25, color: palette[chips.length % palette.length], label: '', perPlayer: 0 });
    save();
    renderChipsView();
  }

  function autoDistribute() {
    const c = cfg();
    const res = E.suggestChipDistribution(c.startingStack, c.chips.map((x) => x.value));
    c.chips.forEach((ch) => { ch.perPlayer = res.counts[ch.value] || 0; });
    save();
    renderChipsView();
    toast(res.leftover ? `${fmt(res.leftover)} can't be made with these chips — add a smaller denomination` : 'Starting stack distributed');
  }

  // ---------------------------------------------------------------- Settings view

  function renderSettings() {
    const c = cfg();
    $('warningMinutes').value = c.warningMinutes;
    $('volume').value = c.sound.volume;
    $('soundEnabled').checked = c.sound.enabled;
    $('oneMinuteWarning').checked = c.oneMinuteWarning;
    $('voiceEnabled').checked = c.sound.voice;
    $('notifications').checked = c.sound.notifications;
    $('keepAwake').checked = c.keepAwake;
    $('pauseAfterBreak').checked = c.pauseAfterBreak;
    $('autoExtend').checked = c.autoExtend !== false;
    $('anteMode').value = c.anteMode || 'auto';
    $('compactNumbers').checked = c.compactNumbers;
    $('railStyle').value = c.theme.rail;
    $('feltText').value = c.theme.feltText != null ? c.theme.feltText : 'THoldem';
    $('feltSwatches').innerHTML = Object.entries(FELTS).map(([k, col]) =>
      `<button class="swatch${c.theme.felt === k ? ' active' : ''}" data-felt="${k}" title="${k}" style="background:radial-gradient(ellipse, ${col}, #000 140%)"></button>`
    ).join('');
    const opts = Object.entries(A.SOUNDS);
    $('soundRows').innerHTML = CUES.map((cue) =>
      `<div class="sound-row" data-cue="${cue.key}">
        <span class="name">${cue.label}</span>
        <select data-f="sound">${opts.map(([k, label]) => `<option value="${k}" ${c.sound[cue.key] === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <button class="btn btn-small" data-act="preview" title="Preview">▶</button>
        <label class="btn btn-small file-btn" title="Upload your own clip (mp3, wav, ogg)">⬆<input type="file" accept="audio/*" data-f="upload" hidden /></label>
        <span class="custom-name">${ui.clipNames[cue.key] ? 'Custom clip: ' + esc(ui.clipNames[cue.key]) : ''}</span>
      </div>`
    ).join('');
    renderVoices();
  }

  function renderVoices() {
    const sel = $('voiceName');
    const vs = A.voices().filter((v) => /^en/i.test(v.lang));
    const list = vs.length ? vs : A.voices();
    sel.innerHTML = '<option value="">Default voice</option>' + list.map((v) => `<option value="${esc(v.name)}" ${cfg().sound.voiceName === v.name ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  }

  function onSettingsChange(e) {
    const t = e.target;
    const c = cfg();
    const row = t.closest('.sound-row');
    if (row) {
      const cue = row.dataset.cue;
      if (t.dataset.f === 'sound') {
        c.sound[cue] = t.value;
        save();
        if (t.value === 'custom' && !ui.clipNames[cue]) toast('Now upload a clip with the ⬆ button');
        else { A.ensure(); A.play(t.value, cue); }
      } else if (t.dataset.f === 'upload' && t.files && t.files[0]) {
        const file = t.files[0];
        file.arrayBuffer().then((buf) => A.storeClip(cue, buf, file.name)).then((dur) => {
          ui.clipNames[cue] = file.name;
          c.sound[cue] = 'custom';
          save();
          renderSettings();
          toast(`Loaded “${esc(file.name)}” (${dur.toFixed(1)}s)`);
          A.play('custom', cue);
        }).catch(() => toast('Could not decode that audio file'));
      }
      return;
    }
    switch (t.id) {
      case 'warningMinutes': c.warningMinutes = Math.max(0, Number(t.value) || 0); break;
      case 'volume': c.sound.volume = Number(t.value); A.setVolume(c.sound.volume); break;
      case 'soundEnabled': c.sound.enabled = t.checked; renderTheme(); break;
      case 'oneMinuteWarning': c.oneMinuteWarning = t.checked; break;
      case 'voiceEnabled': c.sound.voice = t.checked; if (t.checked) A.say('Shuffle up and deal!', c.sound.voiceName); break;
      case 'voiceName': c.sound.voiceName = t.value; A.say('Blinds are now 100 and 200.', t.value); break;
      case 'notifications':
        c.sound.notifications = t.checked;
        if (t.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        break;
      case 'keepAwake': c.keepAwake = t.checked; if (!t.checked) releaseWakeLock(); else if (S.clock.running) requestWakeLock(); break;
      case 'pauseAfterBreak': c.pauseAfterBreak = t.checked; break;
      case 'compactNumbers': c.compactNumbers = t.checked; renderAll(); break;
      case 'railStyle': c.theme.rail = t.value; renderTheme(); break;
      case 'feltText': c.theme.feltText = t.value; renderTheme(); break;
      default: return;
    }
    save();
    if (t.id === 'warningMinutes' || t.id === 'oneMinuteWarning') {
      // Re-arm warnings relative to the time left in the current level.
      const rem = E.getRemaining(S.clock, Date.now());
      S.clock.firedWarnings = warnings().filter((w) => w >= rem || w >= E.levelMs(curLevel()));
      ui.banner = realWarningCrossed(rem) ? { index: S.clock.index, dismissed: false } : null;
      renderClock();
    }
  }

  function exportSetup() {
    const data = JSON.stringify({ app: 'THoldem', exportedAt: new Date().toISOString(), config: cfg() }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (cfg().eventName || 'tholdem').replace(/[^\w-]+/g, '-').toLowerCase() + '-setup.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importSetup(file) {
    file.text().then((txt) => {
      const data = JSON.parse(txt);
      const incoming = data.config || data;
      if (!incoming || !Array.isArray(incoming.levels)) throw new Error('bad file');
      const config = mergeConfig(incoming);
      S = freshState(config);
      ui.undo = [];
      ui.selected = null;
      ui.banner = null;
      save(true);
      renderAll();
      toast('Setup imported — new tournament ready');
    }).catch(() => toast('That file is not a THoldem setup'));
  }

  function factoryReset() {
    confirmModal('Reset everything?', 'All settings, structure, players and the running tournament will be wiped and replaced with the defaults.', 'Reset everything', () => {
      S = freshState();
      ui.undo = [];
      ui.selected = null;
      ui.banner = null;
      save(true);
      renderAll();
      toast('Back to defaults');
    }, true);
  }

  // ---------------------------------------------------------------- Navigation

  function showView(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'structure') { renderStructure(); fillGenForm(); }
    if (name === 'players') renderPlayersView();
    if (name === 'chips') renderChipsView();
    if (name === 'settings') renderSettings();
    try { sessionStorage.setItem('tholdem.view', name); } catch (e) { /* ignore */ }
  }

  function renderAll() {
    renderTheme();
    renderMode();
    document.body.classList.toggle('mode-bigclock', !!cfg().bigClock);
    setText($('bigClockBtn'), cfg().bigClock ? '🂠 Table view' : '⏱ Big clock');
    renderTable();
    renderChipTray();
    renderClock();
    renderStructure();
    renderPlayersView();
    renderChipsView();
    renderSettings();
  }

  // ---------------------------------------------------------------- Wiring

  function bind() {
    document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showView(t.dataset.view); });
    $('playPause').onclick = startPause;
    $('centerClock').onclick = startPause;
    $('nextLevel').onclick = () => gotoLevel(S.clock.index + 1);
    $('prevLevel').onclick = () => gotoLevel(S.clock.index - 1);
    $('plusMin').onclick = () => adjustTime(E.MINUTE);
    $('minusMin').onclick = () => adjustTime(-E.MINUTE);
    $('resetLevel').onclick = resetLevel;
    $('muteBtn').onclick = () => { cfg().sound.enabled = !cfg().sound.enabled; save(); renderTheme(); renderSettings(); toast(cfg().sound.enabled ? 'Sound on' : 'Muted'); };
    $('fullscreenBtn').onclick = toggleFullscreen;
    $('warningClose').onclick = () => { if (ui.banner) ui.banner.dismissed = true; renderBanner(Date.now()); };
    $('overlay').onclick = hideOverlay;

    // Hand controls
    $('seats').addEventListener('click', onSeatClick);
    // Tapping the felt (not a seat, clock or pot) clears the selection.
    $('pokerTable').addEventListener('click', (e) => {
      if (e.target.closest('.seat, .center-clock, .pot-area') || !ui.selected || ui.awardMode) return;
      ui.selected = null;
      renderSeatsOnly();
      renderHandControls();
    });
    $('bigClockBtn').onclick = toggleBigClock;
    $('modeSwitch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) setMode(b.dataset.mode);
    });
    $('bigClock').onclick = startPause;
    $('newHand').onclick = newHand;
    $('callBtn').onclick = call;
    $('foldBtn').onclick = foldSelected;
    $('allInBtn').onclick = allIn;
    $('collectBtn').onclick = collect;
    $('awardBtn').onclick = toggleAward;
    $('cancelAward').onclick = () => { exitAwardMode(); renderSeatsOnly(); renderHandControls(); };
    $('undoBtn').onclick = undo;
    $('betClear').onclick = () => { $('betAmount').value = ''; };
    $('betPlace').onclick = () => placeBet(betAmount());
    $('betAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') placeBet(betAmount()); });
    $('chipTray').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $('betAmount').value = betAmount() + Number(chip.dataset.v);
    });
    $('potArea').addEventListener('click', () => { if (E.potTotal(S.game) > 0) toggleAward(); });

    // Structure
    $('structureBody').addEventListener('change', onStructureChange);
    $('structureBody').addEventListener('click', onStructureClick);
    $('addLevel').onclick = addLevel;
    $('addBreak').onclick = addBreak;
    $('genBtn').onclick = generate;
    $('setAllMinutes').onclick = () => {
      openModal(`<h3>Set every level's length</h3><div class="form-grid"><label>Minutes per level<input type="number" id="allMin" min="0.5" step="0.5" value="${(levels().find((l) => !E.isBreak(l)) || {}).minutes || 15}" /></label></div>
        <div class="row-actions"><button class="btn btn-primary" id="allMinOk">Apply</button></div>`, (root) => {
        const go = () => {
          const v = Math.max(0.5, Number(root.querySelector('#allMin').value) || 15);
          closeModal();
          const cur = curLevel();
          mutateLevels((ls) => ls.forEach((l) => { if (!E.isBreak(l)) l.minutes = v; }));
          if (!E.isBreak(cur)) S.clock = E.gotoLevel(S.clock, levels(), S.clock.index, Date.now(), warnings());
          save();
          renderClock();
        };
        root.querySelector('#allMinOk').onclick = go;
        root.querySelector('#allMin').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      });
    };
    $('presetRow').innerHTML = Object.entries(E.STRUCTURE_PRESETS).map(([k, p]) =>
      `<button class="btn" data-preset="${k}">${esc(p.label)} <span class="muted">${p.levelMinutes}m</span></button>`).join('');
    $('presetRow').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      fillGenForm(E.STRUCTURE_PRESETS[b.dataset.preset]);
      generate();
    });

    // Players
    const pv = $('view-players');
    pv.addEventListener('input', onPlayersInput);
    pv.addEventListener('change', onPlayersChange);
    $('shuffleSeats').onclick = shuffleSeats;
    $('newTournament').onclick = newTournament;
    $('addPayout').onclick = () => { cfg().payoutPercents.push(0); cfg().payoutsCustom = true; save(); renderPlayersView(); };
    $('removePayout').onclick = () => { if (cfg().payoutPercents.length > 1) { cfg().payoutPercents.pop(); cfg().payoutsCustom = true; save(); renderPlayersView(); renderStats(); } };
    $('suggestPayout').onclick = () => { cfg().payoutPercents = E.defaultPayoutPercents(S.game.players.length); cfg().payoutsCustom = false; save(); renderPlayersView(); renderStats(); };

    // Chips
    $('chipEditor').addEventListener('change', onChipsChange);
    $('view-chips').addEventListener('click', onChipsClick);
    $('addChip').onclick = addChip;
    $('autoDistribute').onclick = autoDistribute;

    // Settings
    const sv = $('view-settings');
    sv.addEventListener('change', onSettingsChange);
    $('volume').addEventListener('input', (e) => { A.setVolume(e.target.value); });
    $('feltText').addEventListener('input', (e) => { cfg().theme.feltText = e.target.value; renderTheme(); save(); });
    $('pauseAfterBreak').addEventListener('change', (e) => { cfg().pauseAfterBreak = e.target.checked; save(); });
    $('autoExtend').addEventListener('change', (e) => { cfg().autoExtend = e.target.checked; save(); });
    $('anteMode').addEventListener('change', (e) => { cfg().anteMode = e.target.value === 'auto' ? '' : e.target.value; save(); });
    sv.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (sw) { cfg().theme.felt = sw.dataset.felt; save(); renderTheme(); renderSettings(); return; }
      const pre = e.target.closest('[data-act=preview]');
      if (pre) { A.ensure(); A.setVolume(cfg().sound.volume); A.play(cfg().sound[pre.closest('.sound-row').dataset.cue], pre.closest('.sound-row').dataset.cue); }
    });
    $('exportBtn').onclick = exportSetup;
    $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importSetup(e.target.files[0]); e.target.value = ''; });
    $('factoryReset').onclick = factoryReset;

    // Modal
    $('modalClose').onclick = closeModal;
    $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

    // Global
    document.addEventListener('pointerdown', () => { A.ensure(); A.setVolume(cfg().sound.volume); }, { once: true });
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', () => document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { tick(); if (S.clock.running) requestWakeLock(); }
    });
    // Don't lose a pending (debounced) save when the page is closed or reloaded.
    window.addEventListener('pagehide', () => { if (ui.saveTimer) save(true); });
    window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY && e.newValue) { S = load(); renderAll(); } });
    window.matchMedia('(max-width: 800px)').addEventListener('change', renderSeatsOnly);
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = renderVoices;
  }

  function onKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (e.key === 'Escape') {
      if (!$('modal').hidden) closeModal();
      else if (!$('overlay').hidden) hideOverlay();
      else if (ui.awardMode) { exitAwardMode(); renderSeatsOnly(); renderHandControls(); }
      else if (ui.selected) { ui.selected = null; renderSeatsOnly(); renderHandControls(); }
      return;
    }
    if (typing || !$('modal').hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        // Space on the takeover card only dismisses it — it must not pause the clock.
        if (!$('overlay').hidden) hideOverlay();
        else startPause();
        break;
      case 'b': case 'B': toggleBigClock(); break;
      case 't': case 'T': setMode(cfg().trackStacks ? 'run' : 'full'); break;
      case 'ArrowRight': gotoLevel(S.clock.index + 1); break;
      case 'ArrowLeft': gotoLevel(S.clock.index - 1); break;
      case 'ArrowUp': e.preventDefault(); adjustTime(E.MINUTE); break;
      case 'ArrowDown': e.preventDefault(); adjustTime(-E.MINUTE); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'm': case 'M': $('muteBtn').click(); break;
      case 'n': case 'N': newHand(); break;
      case 'c': case 'C': call(); break;
      case 'x': case 'X': foldSelected(); break;
      default:
        if (/^[1-6]$/.test(e.key)) {
          const views = ['table', 'structure', 'players', 'chips', 'settings', 'help'];
          showView(views[Number(e.key) - 1]);
        }
    }
  }

  function init() {
    S = load();
    if (window.THoldemHelp) $('helpContent').innerHTML = window.THoldemHelp;
    bind();
    A.setVolume(cfg().sound.volume);
    A.loadClips().then((names) => { ui.clipNames = names; renderSettings(); });
    // Catch up silently if the clock kept running while the app was closed.
    const now = Date.now();
    const res = E.tickClock(S.clock, levels(), now, warnings());
    S.clock = res.clock;
    const breakEnd = res.events.find((e) => e.type === 'level' && E.isBreak(levels()[e.from]) && !E.isBreak(levels()[e.index]));
    if (breakEnd && cfg().pauseAfterBreak) S.clock = E.gotoLevel(E.pauseClock(S.clock, now), levels(), breakEnd.index, now, warnings());
    const rem = E.getRemaining(S.clock, now);
    if (realWarningCrossed(rem)) ui.banner = { index: S.clock.index, dismissed: false };
    renderAll();
    let view = 'table';
    try { view = sessionStorage.getItem('tholdem.view') || 'table'; } catch (e) { /* ignore */ }
    showView(view);
    if (S.clock.running) requestWakeLock();
    setInterval(tick, 200);
    // Offline / installable support when served over http(s) (not when opened as a file).
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // Test hook for automated QA.
    window.__tholdem = { get state() { return S; }, tick, ui, setMode };
  }

  document.addEventListener('DOMContentLoaded', init);
})();
