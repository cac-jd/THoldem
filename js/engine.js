/*
 * THoldem engine — pure, DOM-free logic for the tournament clock, blind
 * structures, chips, prize pool and hand/pot tracking.
 *
 * Loaded as a plain <script> in the browser (exposes window.PokerEngine) and
 * via require() in Node for the unit tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MINUTE = 60 * 1000;

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------

  const DEFAULT_CHIPS = [
    { value: 25, color: '#2e9e4f', label: 'Green' },
    { value: 100, color: '#1d1d1f', label: 'Black' },
    { value: 500, color: '#7b3fb3', label: 'Purple' },
    { value: 1000, color: '#e8b923', label: 'Yellow' },
    { value: 5000, color: '#d4541c', label: 'Orange' },
  ];

  const PLAYER_NAMES = [
    'Doyle', 'Stu', 'Phil', 'Johnny', 'Vanessa', 'Daniel',
    'Jennifer', 'Chris', 'Annie', 'Gus', 'Kathy', 'Scotty',
  ];

  const STRUCTURE_PRESETS = {
    home: { label: 'Home Game', startingBigBlinds: 100, levelMinutes: 15, speed: 'standard', breakEvery: 4, breakMinutes: 10, levelCount: 16, antes: 'bb', anteFromLevel: 5 },
    turbo: { label: 'Turbo', startingBigBlinds: 100, levelMinutes: 10, speed: 'fast', breakEvery: 5, breakMinutes: 5, levelCount: 14, antes: 'bb', anteFromLevel: 4 },
    deep: { label: 'Deep Stack', startingBigBlinds: 200, levelMinutes: 20, speed: 'slow', breakEvery: 4, breakMinutes: 15, levelCount: 20, antes: 'bb', anteFromLevel: 6 },
    hyper: { label: 'Hyper', startingBigBlinds: 50, levelMinutes: 5, speed: 'fast', breakEvery: 0, breakMinutes: 0, levelCount: 14, antes: 'none', anteFromLevel: 1 },
  };

  function createDefaultConfig() {
    const startingStack = 10000;
    const chips = DEFAULT_CHIPS.map((c) => ({ ...c, perPlayer: 0 }));
    const dist = suggestChipDistribution(startingStack, chips.map((c) => c.value));
    chips.forEach((c) => { c.perPlayer = dist.counts[c.value] || 0; });
    const playerCount = 8;
    return {
      version: 1,
      eventName: 'Friday Night Poker',
      playerCount,
      playerNames: PLAYER_NAMES.slice(0, playerCount),
      startingStack,
      currency: '$',
      buyIn: 20,
      rebuyCost: 20,
      rebuyChips: 10000,
      addonCost: 10,
      addonChips: 5000,
      rakePercent: 0,
      payoutPercents: defaultPayoutPercents(playerCount),
      chips,
      levels: generateStructure({ startingStack, smallestChip: 25, ...STRUCTURE_PRESETS.home }),
      warningMinutes: 5,
      oneMinuteWarning: true,
      pauseAfterBreak: false,
      trackStacks: false, // Run mode by default; Full mode tracks every hand
      compactNumbers: false,
      theme: { felt: 'green', rail: 'leather' },
      sound: {
        enabled: true,
        volume: 0.8,
        levelUp: 'primetime',
        warning: 'chime',
        breakStart: 'lounge',
        voice: true,
        voiceName: '',
        notifications: false,
      },
      keepAwake: true,
    };
  }

  function defaultPayoutPercents(entrants) {
    if (entrants <= 3) return [100];
    if (entrants <= 6) return [65, 35];
    if (entrants <= 10) return [50, 30, 20];
    if (entrants <= 20) return [45, 27, 18, 10];
    return [40, 25, 15, 12, 8];
  }

  // ---------------------------------------------------------------------------
  // Blind structures
  // ---------------------------------------------------------------------------

  // Big blinds are chosen from this "nice number" ladder (times powers of ten).
  const LADDER = [1, 1.2, 1.5, 1.6, 2, 2.5, 3, 4, 5, 6, 8];
  const SPEED_FACTOR = { slow: 1.1, standard: 1.2, fast: 1.3 };

  function roundTo(value, unit) {
    return Math.round(value / unit) * unit;
  }

  function ceilTo(value, unit) {
    return Math.ceil(value / unit - 1e-9) * unit;
  }

  /** Smallest ladder value >= min that is a multiple of `unit`. */
  function nextNiceNumber(min, unit) {
    let exp = Math.floor(Math.log10(Math.max(min, 1)));
    for (let guard = 0; guard < 30; guard++) {
      const mag = Math.pow(10, exp);
      for (const step of LADDER) {
        const v = Math.round(step * mag);
        if (v >= min - 1e-9 && v % unit === 0) return v;
      }
      exp++;
    }
    return ceilTo(min, unit);
  }

  /**
   * Build a level list from high-level parameters.
   * opts: startingStack, smallestChip, levelMinutes, speed, levelCount,
   *       breakEvery, breakMinutes, antes ('none' | 'bb' | 'classic'), anteFromLevel,
   *       startingBigBlinds (depth, default 100),
   *       chipValues (denominations; once the small blind is 4× a bigger chip,
   *       blinds snap to multiples of it so the small chips can be colored up)
   */
  function generateStructure(opts) {
    const o = {
      startingStack: 10000, smallestChip: 25, levelMinutes: 15, speed: 'standard',
      levelCount: 16, breakEvery: 4, breakMinutes: 10, antes: 'bb', anteFromLevel: 5,
      startingBigBlinds: 100,
      ...opts,
    };
    const unit = Math.max(1, Math.round(o.smallestChip));
    const bbUnit = unit * 2;
    const factor = SPEED_FACTOR[o.speed] || SPEED_FACTOR.standard;
    const levelCount = clampInt(o.levelCount, 1, 60);

    let bb = nextNiceNumber(Math.max(bbUnit, o.startingStack / Math.max(1, o.startingBigBlinds)), bbUnit);
    const chipVals = [...new Set([unit, ...(o.chipValues || []).map(Number)])].filter((v) => v >= unit).sort((a, b) => a - b);
    const snapUnit = (sb) => chipVals.reduce((u, v) => (sb >= 4 * v ? v : u), unit);
    const levels = [];
    let played = 0;
    for (let i = 1; i <= levelCount; i++) {
      const sb = bb / 2;
      const u = snapUnit(sb);
      let ante = 0;
      if (i >= o.anteFromLevel) {
        if (o.antes === 'bb') ante = bb;
        else if (o.antes === 'classic') ante = Math.max(u, ceilTo(bb / 8, u));
      }
      levels.push({ type: 'level', sb, bb, ante, minutes: o.levelMinutes });
      played++;
      if (o.breakEvery > 0 && o.breakMinutes > 0 && played % o.breakEvery === 0 && i < levelCount) {
        levels.push({ type: 'break', minutes: o.breakMinutes, label: 'Break' });
      }
      // A little tolerance so we land on 2,000 rather than overshooting to 3,000.
      const nextMin = Math.max(bb + bbUnit, bb * factor * 0.96);
      bb = nextNiceNumber(nextMin, 2 * snapUnit(nextMin / 2));
    }
    return levels;
  }

  /** A sensible next level after `levels` (used to keep the clock going past the last level). */
  function extendLevel(levels, chipValues) {
    const plays = levels.filter((l) => !isBreak(l));
    const last = plays[plays.length - 1];
    if (!last) return { type: 'level', sb: 25, bb: 50, ante: 0, minutes: 15 };
    const vals = (chipValues || []).map(Number).filter((v) => v > 0).sort((a, b) => a - b);
    const smallest = vals[0] || Math.max(1, last.sb);
    const u = vals.reduce((acc, v) => (last.sb * 1.25 >= 4 * v ? v : acc), smallest);
    const bb = nextNiceNumber(Math.max(last.bb + 2 * u, last.bb * 1.25), 2 * u);
    let ante = 0;
    if (last.ante > 0) ante = last.ante >= last.bb ? bb : Math.max(u, ceilTo(bb / 8, u));
    return { type: 'level', sb: bb / 2, bb, ante, minutes: last.minutes };
  }

  function isBreak(level) {
    return !!level && level.type === 'break';
  }

  /** 1-based level number shown to players (breaks are not counted). */
  function levelNumber(levels, index) {
    let n = 0;
    for (let i = 0; i <= index && i < levels.length; i++) if (!isBreak(levels[i])) n++;
    return n;
  }

  function findNext(levels, index, predicate) {
    for (let i = index + 1; i < levels.length; i++) if (predicate(levels[i])) return i;
    return -1;
  }

  function levelMs(level) {
    return Math.max(0, Number(level && level.minutes) || 0) * MINUTE;
  }

  /** Milliseconds until the start of the next break (or -1 if none). */
  function msUntilNextBreak(levels, index, remainingMs) {
    if (isBreak(levels[index])) return 0;
    const b = findNext(levels, index, isBreak);
    if (b < 0) return -1;
    let ms = remainingMs;
    for (let i = index + 1; i < b; i++) ms += levelMs(levels[i]);
    return ms;
  }

  function validateLevels(levels) {
    const problems = [];
    let prevBb = 0;
    levels.forEach((l, i) => {
      if (!(l.minutes > 0)) problems.push({ index: i, message: 'Duration must be greater than zero' });
      if (isBreak(l)) return;
      if (!(l.bb > 0)) problems.push({ index: i, message: 'Big blind must be greater than zero' });
      if (l.sb > l.bb) problems.push({ index: i, message: 'Small blind is larger than the big blind' });
      if (l.ante < 0) problems.push({ index: i, message: 'Ante cannot be negative' });
      if (prevBb && l.bb < prevBb) problems.push({ index: i, message: 'Big blind goes down from the previous level' });
      prevBb = l.bb || prevBb;
    });
    return problems;
  }

  // ---------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------

  function createClock(levels, warningsMs) {
    const len = levelMs(levels[0]);
    return {
      index: 0,
      running: false,
      remainingMs: len,
      endsAt: null,
      firedWarnings: (warningsMs || []).filter((w) => w >= len),
      finished: false,
      elapsedMs: 0,
      startedAt: null,
    };
  }

  function getRemaining(clock, now) {
    if (clock.running && clock.endsAt != null) return Math.max(0, clock.endsAt - now);
    return Math.max(0, clock.remainingMs);
  }

  function startClock(clock, now) {
    if (clock.running || clock.finished) return clock;
    return { ...clock, running: true, endsAt: now + clock.remainingMs, startedAt: clock.startedAt || now };
  }

  function pauseClock(clock, now) {
    if (!clock.running) return clock;
    return { ...clock, running: false, remainingMs: getRemaining(clock, now), endsAt: null };
  }

  /** Warnings that are already "in the past" for a level of this length are pre-fired. */
  function initialWarnings(level, remainingMs, warningsMs) {
    const len = levelMs(level);
    return warningsMs.filter((w) => w >= len || w >= remainingMs);
  }

  function gotoLevel(clock, levels, index, now, warningsMs) {
    const i = clampInt(index, 0, levels.length - 1);
    const remainingMs = levelMs(levels[i]);
    const next = {
      ...clock,
      index: i,
      remainingMs,
      finished: false,
      firedWarnings: initialWarnings(levels[i], remainingMs, warningsMs || []),
    };
    next.endsAt = clock.running ? now + remainingMs : null;
    return next;
  }

  function adjustClock(clock, deltaMs, now) {
    const rem = Math.max(0, getRemaining(clock, now) + deltaMs);
    const next = { ...clock, remainingMs: rem, finished: false };
    if (clock.running) next.endsAt = now + rem;
    // Re-arm any warning the clock was moved back above; crossed ones stay fired.
    next.firedWarnings = (clock.firedWarnings || []).filter((w) => w >= rem);
    return next;
  }

  /**
   * Advance the clock to `now`, returning the new clock and the events that
   * happened: {type:'level', index, from} | {type:'warning', ms, index} | {type:'finished'}.
   * Handles catching up across several levels (e.g. laptop asleep).
   */
  function tickClock(clock, levels, now, warningsMs) {
    const events = [];
    if (!clock.running || clock.finished) return { clock, events };
    const warnings = (warningsMs || []).slice().sort((a, b) => b - a);
    let c = { ...clock, firedWarnings: (clock.firedWarnings || []).slice() };

    let guard = 0;
    while (c.endsAt - now <= 0 && guard++ < 1000) {
      if (c.index >= levels.length - 1) {
        c = { ...c, running: false, remainingMs: 0, endsAt: null, finished: true };
        events.push({ type: 'finished', index: c.index });
        return { clock: c, events };
      }
      const from = c.index;
      const index = c.index + 1;
      const len = levelMs(levels[index]);
      c = { ...c, index, endsAt: c.endsAt + len, remainingMs: len };
      c.firedWarnings = initialWarnings(levels[index], len, warnings);
      events.push({ type: 'level', index, from });
    }

    const remaining = Math.max(0, c.endsAt - now);
    c.remainingMs = remaining;
    // Only fire the most urgent unfired warning that has been crossed.
    const crossed = warnings.filter((w) => remaining <= w && !c.firedWarnings.includes(w));
    if (crossed.length && c.index < levels.length - 1) {
      const w = crossed[crossed.length - 1];
      crossed.forEach((x) => c.firedWarnings.push(x));
      events.push({ type: 'warning', ms: w, index: c.index });
    }
    return { clock: c, events };
  }

  function warningThresholds(config) {
    const list = [];
    const mins = Number(config.warningMinutes);
    if (mins > 0) list.push(Math.round(mins * MINUTE));
    if (config.oneMinuteWarning && mins !== 1) list.push(MINUTE);
    return list;
  }

  // ---------------------------------------------------------------------------
  // Chips
  // ---------------------------------------------------------------------------

  function stackFromChips(chips) {
    return chips.reduce((sum, c) => sum + (Number(c.value) || 0) * (Number(c.perPlayer) || 0), 0);
  }

  /**
   * Suggest how many of each denomination make up a starting stack, keeping
   * enough small chips to make change. Returns {counts: {value: n}, leftover}.
   */
  function suggestChipDistribution(stack, values) {
    const vals = [...new Set(values.map(Number).filter((v) => v > 0))].sort((a, b) => a - b);
    const counts = {};
    vals.forEach((v) => { counts[v] = 0; });
    let remaining = Math.max(0, Math.round(stack));
    const usable = vals.filter((v) => v <= remaining);
    for (let i = 0; i < usable.length - 1; i++) {
      const v = usable[i];
      const nextV = usable[i + 1];
      const target = Math.max(4, Math.ceil((2 * nextV) / v));
      const cap = Math.floor((remaining * 0.5) / v);
      const n = Math.max(0, Math.min(target, cap));
      counts[v] += n;
      remaining -= n * v;
    }
    for (let i = usable.length - 1; i >= 0; i--) {
      const v = usable[i];
      const n = Math.floor(remaining / v);
      counts[v] += n;
      remaining -= n * v;
    }
    return { counts, leftover: remaining };
  }

  /** Denominations that are no longer needed for any remaining blind or ante. */
  function colorUpCandidates(chipValues, levels, fromIndex) {
    const vals = [...new Set(chipValues.map(Number).filter((v) => v > 0))].sort((a, b) => a - b);
    const amounts = [];
    for (let i = Math.max(0, fromIndex); i < levels.length; i++) {
      const l = levels[i];
      if (isBreak(l)) continue;
      [l.sb, l.bb, l.ante].forEach((a) => { if (a > 0) amounts.push(a); });
    }
    if (!amounts.length) return [];
    const out = [];
    for (let i = 0; i < vals.length - 1; i++) {
      const nextV = vals[i + 1];
      if (amounts.every((a) => a % nextV === 0)) out.push(vals[i]);
      else break;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Prize pool
  // ---------------------------------------------------------------------------

  function prizePool(config, players) {
    const entries = players.length;
    const rebuys = players.reduce((s, p) => s + (p.rebuys || 0), 0);
    const addons = players.reduce((s, p) => s + (p.addons || 0), 0);
    const gross = entries * (config.buyIn || 0) + rebuys * (config.rebuyCost || 0) + addons * (config.addonCost || 0);
    const rake = Math.round(gross * ((config.rakePercent || 0) / 100) * 100) / 100;
    return { entries, rebuys, addons, gross, rake, net: gross - rake };
  }

  function payouts(net, percents) {
    const total = percents.reduce((s, p) => s + p, 0) || 1;
    const amounts = percents.map((p) => Math.floor((net * p) / total));
    const diff = Math.round((net - amounts.reduce((s, a) => s + a, 0)) * 100) / 100;
    if (amounts.length) amounts[0] = Math.round((amounts[0] + diff) * 100) / 100;
    return amounts;
  }

  // ---------------------------------------------------------------------------
  // Players, hands & pot
  // ---------------------------------------------------------------------------

  function createPlayers(config) {
    const out = [];
    for (let i = 0; i < config.playerCount; i++) {
      out.push({
        id: 'p' + (i + 1),
        seat: i,
        name: (config.playerNames && config.playerNames[i]) || 'Player ' + (i + 1),
        stack: config.startingStack,
        bet: 0,
        folded: false,
        out: false,
        place: null,
        rebuys: 0,
        addons: 0,
      });
    }
    return out;
  }

  function createGame(config) {
    return { players: createPlayers(config), dealerSeat: 0, pot: 0, handNumber: 0, lastBlinds: null };
  }

  function clone(game) {
    return { ...game, players: game.players.map((p) => ({ ...p })) };
  }

  function activePlayers(game) {
    return game.players.filter((p) => !p.out).sort((a, b) => a.seat - b.seat);
  }

  /** Next active player clockwise after `seat`. */
  function nextActiveSeat(game, seat) {
    const act = activePlayers(game);
    if (!act.length) return seat;
    const after = act.find((p) => p.seat > seat);
    return (after || act[0]).seat;
  }

  function playerAtSeat(game, seat) {
    return game.players.find((p) => p.seat === seat);
  }

  /**
   * Move chips from a stack to the player's bet. `committed` tracks what the
   * player has put in this hand (for side pots); antes are dead money and
   * don't count towards it.
   */
  function takeChips(p, amount, dead) {
    const amt = Math.max(0, Math.min(p.stack, Math.round(amount)));
    p.stack -= amt;
    p.bet += amt;
    if (!dead) p.committed = (p.committed || 0) + amt;
    return amt;
  }

  function isActiveSeat(game, seat) {
    return game.players.some((p) => p.seat === seat && !p.out);
  }

  /** Blind positions: {sbSeat, bbSeat}. sbSeat is null for a dead small blind. Heads-up: dealer posts SB. */
  function blindSeats(game) {
    if (game.handNumber > 0 && game.lastBlinds && game.lastBlinds.bbSeat != null) {
      return { sbSeat: game.lastBlinds.sbSeat, bbSeat: game.lastBlinds.bbSeat };
    }
    return blindsFromButton(game);
  }

  function blindsFromButton(game) {
    const act = activePlayers(game);
    if (act.length < 2) return { sbSeat: null, bbSeat: null };
    const dealer = isActiveSeat(game, game.dealerSeat) ? game.dealerSeat : nextActiveSeat(game, game.dealerSeat);
    const sbSeat = act.length === 2 ? dealer : nextActiveSeat(game, dealer);
    const bbSeat = nextActiveSeat(game, sbSeat);
    return { sbSeat, sbPos: sbSeat, bbSeat, dealerSeat: dealer };
  }

  /**
   * Dead-button rule: the big blind always moves forward exactly one active
   * player, so nobody skips (or repeats) the big blind when players bust.
   * The small blind goes to last hand's big-blind seat (dead if that player
   * busted) and the button to last hand's small-blind position.
   */
  function advanceBlinds(game, prev) {
    const act = activePlayers(game);
    const bbSeat = nextActiveSeat(game, prev.bbSeat);
    if (act.length === 2) {
      const other = act.find((p) => p.seat !== bbSeat).seat;
      return { dealerSeat: other, sbSeat: other, sbPos: other, bbSeat };
    }
    const sbPos = prev.bbSeat;
    const sbSeat = isActiveSeat(game, sbPos) ? sbPos : null;
    const dealerSeat = prev.sbPos != null ? prev.sbPos : prev.sbSeat != null ? prev.sbSeat : game.dealerSeat;
    return { dealerSeat, sbSeat, sbPos, bbSeat };
  }

  /**
   * Start a new hand: move the button (except for the very first hand), clear
   * folds, post the blinds and then the antes for the current level.
   * anteMode: 'bb' (big blind posts one ante for the table) or 'each'.
   */
  function startHand(game, level, anteMode) {
    const g = clone(game);
    g.players.forEach((p) => { p.folded = !!p.out; });
    // Any uncollected bets from an abandoned hand stay in the pot (as dead money).
    g.pot += g.players.reduce((s, p) => s + p.bet, 0);
    g.players.forEach((p) => { p.bet = 0; p.committed = 0; });
    g.lastAward = null;
    const act = activePlayers(g);
    if (act.length < 2) return g;
    const prev = g.handNumber > 0 && !g.manualButton ? g.lastBlinds : null;
    let seats;
    if (prev && prev.bbSeat != null) {
      seats = advanceBlinds(g, prev);
    } else {
      if (g.handNumber > 0 && !g.manualButton) g.dealerSeat = nextActiveSeat(g, g.dealerSeat);
      seats = blindsFromButton(g);
    }
    g.manualButton = false;
    g.dealerSeat = seats.dealerSeat;
    g.handNumber += 1;
    const posted = { sb: 0, bb: 0, ante: 0 };
    g.lastBlinds = { sbSeat: seats.sbSeat, sbPos: seats.sbPos, bbSeat: seats.bbSeat, ...posted };
    if (!level || isBreak(level)) return g;
    // Blinds first, then antes from whatever is left (a short big blind keeps their blind live).
    if (seats.sbSeat != null) posted.sb = takeChips(playerAtSeat(g, seats.sbSeat), level.sb);
    posted.bb = takeChips(playerAtSeat(g, seats.bbSeat), level.bb);
    if (level.ante > 0) {
      const payers = anteMode === 'each' ? act.map((p) => playerAtSeat(g, p.seat)) : [playerAtSeat(g, seats.bbSeat)];
      payers.forEach((p) => {
        // Antes are dead money: straight into the pot, not part of anyone's bet.
        const amt = Math.max(0, Math.min(p.stack, level.ante));
        p.stack -= amt;
        g.pot += amt;
        posted.ante += amt;
      });
    }
    Object.assign(g.lastBlinds, posted);
    return g;
  }

  function placeBet(game, playerId, amount) {
    const g = clone(game);
    const p = g.players.find((x) => x.id === playerId);
    if (!p || p.out || p.folded) return { game: g, amount: 0 };
    const amt = takeChips(p, amount);
    return { game: g, amount: amt };
  }

  /** Bring `playerId`'s bet up to the largest bet on the table. */
  function callBet(game, playerId) {
    const max = Math.max(0, ...game.players.map((p) => p.bet));
    const p = game.players.find((x) => x.id === playerId);
    if (!p) return { game: clone(game), amount: 0 };
    return placeBet(game, playerId, max - p.bet);
  }

  function fold(game, playerId) {
    const g = clone(game);
    const p = g.players.find((x) => x.id === playerId);
    if (p) p.folded = true;
    return g;
  }

  function collectBets(game) {
    const g = clone(game);
    g.pot += g.players.reduce((s, p) => s + p.bet, 0);
    g.players.forEach((p) => { p.bet = 0; });
    return g;
  }

  function addToPot(game, amount) {
    const g = clone(game);
    g.pot = Math.max(0, g.pot + Math.round(amount));
    return g;
  }

  function potTotal(game) {
    return game.pot + game.players.reduce((s, p) => s + p.bet, 0);
  }

  /**
   * Split `amount` between players in whole `unit`s (the smallest chip);
   * odd chips go to the first winner left of the button.
   */
  function splitAmong(g, players, amount, unit) {
    const u = Math.max(1, unit || 1);
    const order = players.slice().sort((a, b) => seatDistance(g, g.dealerSeat, a.seat) - seatDistance(g, g.dealerSeat, b.seat));
    const share = Math.floor(amount / order.length / u) * u;
    let rest = amount - share * order.length;
    order.forEach((p) => {
      const extra = Math.min(rest, u);
      p.stack += share + extra;
      rest -= extra;
    });
    if (rest > 0) order[0].stack += rest;
  }

  /**
   * Award the pot to the best hand (several ids = a split). Side pots are
   * respected: a winner only collects, from each player, up to what they put
   * in themselves. Whatever they can't win stays in the pot as a side pot for
   * the next award; if only one live player is left in it (or nobody), it is
   * returned automatically as an uncalled bet.
   * Returns the new game; `game.lastAward` = {won, sidePot, returned}.
   */
  function awardPot(game, winnerIds, unit) {
    const g = collectBets(game);
    const winners = g.players.filter((p) => winnerIds.includes(p.id));
    const total = g.pot;
    if (!winners.length || total <= 0) return g;
    const c = (p) => Math.max(0, p.committed || 0);
    const tracked = g.players.reduce((s, p) => s + c(p), 0);
    const dead = Math.max(0, total - tracked);
    const cap = Math.max(...winners.map(c));

    // Pay out layer by layer (main pot, then side pots) up to the biggest winner's stake.
    const cuts = [...new Set(g.players.map(c).filter((v) => v > 0 && v <= cap))].sort((a, b) => a - b);
    if (!cuts.length || cuts[cuts.length - 1] !== cap) cuts.push(cap);
    let prev = 0;
    let won = 0;
    cuts.forEach((cut, i) => {
      let layer = g.players.reduce((s, p) => s + Math.min(c(p), cut) - Math.min(c(p), prev), 0);
      if (i === 0) layer += dead;
      const eligible = winners.filter((w) => c(w) >= cut);
      if (layer > 0) {
        splitAmong(g, eligible.length ? eligible : winners, layer, unit);
        won += layer;
      }
      prev = cut;
    });

    g.players.forEach((p) => { p.committed = Math.max(0, c(p) - cap); });
    g.pot = total - won;

    // What's left is a side pot. If nobody (or only one live player) can contest it, give it back.
    let returned = 0;
    if (g.pot > 0) {
      const contenders = g.players.filter((p) => p.committed > 0 && !p.folded && !p.out && !winnerIds.includes(p.id));
      if (contenders.length <= 1) {
        const owners = g.players.filter((p) => p.committed > 0);
        if (contenders.length === 1) {
          contenders[0].stack += g.pot;
        } else {
          owners.forEach((p) => { p.stack += p.committed; });
          const rest = g.pot - owners.reduce((s, p) => s + p.committed, 0);
          if (rest > 0) splitAmong(g, winners, rest, unit);
        }
        returned = g.pot;
        g.pot = 0;
        g.players.forEach((p) => { p.committed = 0; });
      }
    }
    g.lastAward = { won, sidePot: g.pot, returned };
    return g;
  }

  function seatDistance(game, fromSeat, toSeat) {
    const n = Math.max(...game.players.map((p) => p.seat)) + 1;
    return ((toSeat - fromSeat - 1 + n) % n) + 1;
  }

  function eliminate(game, playerId) {
    const g = clone(game);
    const p = g.players.find((x) => x.id === playerId);
    if (!p || p.out) return g;
    const remaining = activePlayers(g).length;
    // Chips already bet stay in the pot; any remaining stack leaves play.
    g.pot += p.bet;
    p.bet = 0;
    p.stack = 0;
    p.out = true;
    p.folded = true;
    p.place = remaining;
    return g;
  }

  function reinstate(game, playerId, stack) {
    const g = clone(game);
    const p = g.players.find((x) => x.id === playerId);
    if (!p || !p.out) return g;
    const place = p.place;
    p.out = false;
    p.folded = false;
    p.place = null;
    p.stack = Math.max(0, Math.round(stack || 0));
    // Everyone who busted before this player moves up one place.
    g.players.forEach((q) => { if (q.out && q.place != null && q.place > place) q.place -= 1; });
    return g;
  }

  function rebuy(game, playerId, chips) {
    const g = clone(game);
    const p = g.players.find((x) => x.id === playerId);
    if (!p) return g;
    if (p.out) {
      const re = reinstate(g, playerId, 0);
      return rebuy(re, playerId, chips);
    }
    p.stack += Math.round(chips);
    p.rebuys += 1;
    return g;
  }

  function addon(game, playerId, chips) {
    const g = clone(game);
    const p = g.players.find((x) => x.id === playerId);
    if (!p || p.out) return g;
    p.stack += Math.round(chips);
    p.addons += 1;
    return g;
  }

  /** Chips handed out so far (buy-ins, rebuys, add-ons) — used when hands aren't tracked. */
  function chipsIssued(config, players) {
    return players.reduce((s, p) => s + (config.startingStack || 0) + (p.rebuys || 0) * (config.rebuyChips || 0) + (p.addons || 0) * (config.addonChips || 0), 0);
  }

  function chipsInPlay(game) {
    return game.players.reduce((s, p) => s + p.stack + p.bet, 0) + game.pot;
  }

  /** Resize the table to `count` seats, keeping existing players and their stacks. */
  function resizePlayers(game, config) {
    const g = clone(game);
    const count = config.playerCount;
    // Chips already bet by removed seats stay in the pot.
    g.players.forEach((p) => { if (p.seat >= count) g.pot += p.bet; });
    g.players = g.players.filter((p) => p.seat < count);
    for (let i = 0; i < count; i++) {
      const name = (config.playerNames && config.playerNames[i]) || 'Player ' + (i + 1);
      let p = g.players.find((x) => x.seat === i);
      if (!p) {
        p = { id: 'p' + (i + 1) + '-' + Date.now().toString(36), seat: i, name, stack: config.startingStack, bet: 0, folded: false, out: false, place: null, rebuys: 0, addons: 0 };
        g.players.push(p);
      } else {
        p.name = name;
      }
    }
    g.players.sort((a, b) => a.seat - b.seat);
    if (!g.players.some((p) => p.seat === g.dealerSeat)) g.dealerSeat = 0;
    return g;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function formatChips(n, compact) {
    const v = Math.round(Number(n) || 0);
    if (compact && Math.abs(v) >= 1000) {
      const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
      for (const [div, suffix] of units) {
        if (Math.abs(v) >= div) {
          const x = v / div;
          return (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + suffix;
        }
      }
    }
    return v.toLocaleString('en-US');
  }

  function formatMoney(n, currency) {
    const v = Number(n) || 0;
    const s = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (currency || '') + s;
  }

  function clampInt(v, min, max) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  return {
    MINUTE,
    DEFAULT_CHIPS,
    PLAYER_NAMES,
    STRUCTURE_PRESETS,
    createDefaultConfig,
    defaultPayoutPercents,
    nextNiceNumber,
    generateStructure,
    extendLevel,
    isBreak,
    levelNumber,
    findNext,
    levelMs,
    msUntilNextBreak,
    validateLevels,
    createClock,
    getRemaining,
    startClock,
    pauseClock,
    gotoLevel,
    adjustClock,
    tickClock,
    warningThresholds,
    stackFromChips,
    suggestChipDistribution,
    colorUpCandidates,
    prizePool,
    payouts,
    createPlayers,
    createGame,
    activePlayers,
    nextActiveSeat,
    blindSeats,
    startHand,
    placeBet,
    callBet,
    fold,
    collectBets,
    addToPot,
    potTotal,
    awardPot,
    eliminate,
    reinstate,
    rebuy,
    addon,
    chipsInPlay,
    chipsIssued,
    resizePlayers,
    formatClock,
    formatChips,
    formatMoney,
    clampInt,
  };
});
