const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

const MIN = E.MINUTE;
const lv = (sb, bb, minutes, ante = 0) => ({ type: 'level', sb, bb, ante, minutes });
const brk = (minutes) => ({ type: 'break', minutes, label: 'Break' });

test('default config: chip distribution adds up to the starting stack', () => {
  const c = E.createDefaultConfig();
  assert.equal(E.stackFromChips(c.chips), c.startingStack);
  assert.equal(c.playerNames.length, c.playerCount);
  assert.deepEqual(E.validateLevels(c.levels), []);
});

test('generateStructure: increasing blinds, SB is half BB, multiples of the smallest chip', () => {
  for (const preset of Object.values(E.STRUCTURE_PRESETS)) {
    const ls = E.generateStructure({ startingStack: 10000, smallestChip: 25, ...preset });
    const levels = ls.filter((l) => !E.isBreak(l));
    assert.equal(levels.length, preset.levelCount);
    let prev = 0;
    for (const l of levels) {
      assert.ok(l.bb > prev, `bb ${l.bb} should grow past ${prev}`);
      assert.equal(l.sb * 2, l.bb);
      assert.equal(l.sb % 25, 0);
      prev = l.bb;
    }
    assert.ok(!E.isBreak(ls[ls.length - 1]), 'structure should not end on a break');
  }
});

test('generateStructure: breaks inserted every N levels and antes start at the right level', () => {
  const ls = E.generateStructure({ levelCount: 9, breakEvery: 3, breakMinutes: 10, antes: 'classic', anteFromLevel: 4 });
  assert.deepEqual(ls.map((l) => l.type), ['level', 'level', 'level', 'break', 'level', 'level', 'level', 'break', 'level', 'level', 'level']);
  const levels = ls.filter((l) => !E.isBreak(l));
  assert.equal(levels[2].ante, 0);
  assert.ok(levels[3].ante > 0 && levels[3].ante < levels[3].bb);
});

test('levelNumber skips breaks', () => {
  const ls = [lv(25, 50, 10), brk(5), lv(50, 100, 10)];
  assert.equal(E.levelNumber(ls, 0), 1);
  assert.equal(E.levelNumber(ls, 2), 2);
});

test('clock: start, pause and resume keep the remaining time', () => {
  const ls = [lv(25, 50, 10), lv(50, 100, 10)];
  let c = E.createClock(ls);
  c = E.startClock(c, 0);
  assert.equal(E.getRemaining(c, 3 * MIN), 7 * MIN);
  c = E.pauseClock(c, 3 * MIN);
  assert.equal(E.getRemaining(c, 100 * MIN), 7 * MIN);
  c = E.startClock(c, 100 * MIN);
  assert.equal(E.getRemaining(c, 101 * MIN), 6 * MIN);
});

test('clock: fires the 5-minute warning once, then advances the level', () => {
  const ls = [lv(25, 50, 10), lv(50, 100, 10)];
  const w = [5 * MIN];
  let c = E.startClock(E.createClock(ls), 0);
  let r = E.tickClock(c, ls, 4 * MIN, w);
  assert.equal(r.events.length, 0);
  r = E.tickClock(r.clock, ls, 5 * MIN, w);
  assert.deepEqual(r.events.map((e) => e.type), ['warning']);
  r = E.tickClock(r.clock, ls, 5 * MIN + 500, w);
  assert.equal(r.events.length, 0, 'warning must not repeat');
  r = E.tickClock(r.clock, ls, 10 * MIN, w);
  assert.deepEqual(r.events.map((e) => e.type), ['level']);
  assert.equal(r.clock.index, 1);
  assert.equal(E.getRemaining(r.clock, 10 * MIN), 10 * MIN);
});

test('clock: no warning at the start of a level shorter than the warning', () => {
  const ls = [lv(25, 50, 3), lv(50, 100, 3), lv(75, 150, 3)];
  let c = E.startClock(E.createClock(ls), 0);
  c.firedWarnings = [5 * MIN];
  const r = E.tickClock(c, ls, 3 * MIN + 10, [5 * MIN]);
  assert.deepEqual(r.events.map((e) => e.type), ['level']);
});

test('clock: 5-minute and 1-minute warnings both fire', () => {
  const ls = [lv(25, 50, 10), lv(50, 100, 10)];
  const w = [5 * MIN, MIN];
  let c = E.startClock(E.createClock(ls), 0);
  let r = E.tickClock(c, ls, 5 * MIN, w);
  assert.equal(r.events[0].ms, 5 * MIN);
  r = E.tickClock(r.clock, ls, 9 * MIN, w);
  assert.equal(r.events[0].ms, MIN);
});

test('clock: catches up across several levels after sleeping', () => {
  const ls = [lv(25, 50, 10), brk(5), lv(50, 100, 10), lv(75, 150, 10)];
  let c = E.startClock(E.createClock(ls), 0);
  const r = E.tickClock(c, ls, 22 * MIN, [5 * MIN]);
  assert.equal(r.clock.index, 2);
  assert.equal(E.getRemaining(r.clock, 22 * MIN), 3 * MIN);
  assert.deepEqual(r.events.map((e) => e.type), ['level', 'level', 'warning']);
});

test('clock: finishes at the end of the last level', () => {
  const ls = [lv(25, 50, 1)];
  const c = E.startClock(E.createClock(ls), 0);
  const r = E.tickClock(c, ls, 2 * MIN, [5 * MIN]);
  assert.equal(r.clock.finished, true);
  assert.equal(r.clock.running, false);
  assert.deepEqual(r.events.map((e) => e.type), ['finished']);
});

test('clock: adding time re-arms a warning that already fired', () => {
  const ls = [lv(25, 50, 10), lv(50, 100, 10)];
  const w = [5 * MIN];
  let r = E.tickClock(E.startClock(E.createClock(ls), 0), ls, 6 * MIN, w);
  assert.equal(r.events[0].type, 'warning');
  let c = E.adjustClock(r.clock, 2 * MIN, 6 * MIN); // 6 min left now
  assert.equal(E.getRemaining(c, 6 * MIN), 6 * MIN);
  r = E.tickClock(c, ls, 7 * MIN, w);
  assert.equal(r.events[0].type, 'warning');
});

test('clock: gotoLevel resets time and keeps running state', () => {
  const ls = [lv(25, 50, 10), lv(50, 100, 20)];
  let c = E.startClock(E.createClock(ls), 0);
  c = E.gotoLevel(c, ls, 1, 3 * MIN, [5 * MIN]);
  assert.equal(c.index, 1);
  assert.equal(E.getRemaining(c, 3 * MIN), 20 * MIN);
  assert.equal(c.running, true);
});

test('msUntilNextBreak sums the levels before the break', () => {
  const ls = [lv(25, 50, 10), lv(50, 100, 15), brk(10)];
  assert.equal(E.msUntilNextBreak(ls, 0, 4 * MIN), 19 * MIN);
  assert.equal(E.msUntilNextBreak([lv(1, 2, 1)], 0, MIN), -1);
});

test('suggestChipDistribution always makes the exact stack when possible', () => {
  const vals = [25, 100, 500, 1000, 5000];
  for (const stack of [1500, 3000, 5000, 10000, 20000, 25000, 50000]) {
    const r = E.suggestChipDistribution(stack, vals);
    const total = Object.entries(r.counts).reduce((s, [v, n]) => s + v * n, 0);
    assert.equal(total, stack);
    assert.equal(r.leftover, 0);
    assert.ok(r.counts[25] >= 4, 'keeps small chips for change');
  }
  assert.equal(E.suggestChipDistribution(110, [25, 100]).leftover, 10);
});

test('colorUpCandidates: removes chips no remaining blind needs', () => {
  const ls = [lv(25, 50, 10), lv(100, 200, 10), lv(200, 400, 10)];
  assert.deepEqual(E.colorUpCandidates([25, 100, 500], ls, 0), []);
  assert.deepEqual(E.colorUpCandidates([25, 100, 500], ls, 1), [25]);
});

test('prize pool and payouts add up', () => {
  const cfg = { buyIn: 20, rebuyCost: 20, addonCost: 10, rakePercent: 10 };
  const players = [{ rebuys: 1, addons: 1 }, { rebuys: 0, addons: 1 }, {}, {}];
  const pool = E.prizePool(cfg, players);
  assert.equal(pool.gross, 4 * 20 + 20 + 2 * 10);
  assert.equal(pool.net, 108);
  const pays = E.payouts(pool.net, [50, 30, 20]);
  assert.equal(pays.reduce((s, x) => s + x, 0), 108);
  assert.ok(pays[0] >= pays[1] && pays[1] >= pays[2]);
});

function game(n, stack = 1000) {
  return E.createGame({ playerCount: n, startingStack: stack, playerNames: [] });
}

test('startHand posts blinds after the button (first hand keeps the button)', () => {
  let g = game(4);
  g = E.startHand(g, lv(10, 20, 10), 'bb');
  assert.equal(g.dealerSeat, 0);
  assert.equal(g.players[1].bet, 10);
  assert.equal(g.players[2].bet, 20);
  assert.equal(E.potTotal(g), 30);
  g = E.awardPot(g, ['p3']);
  g = E.startHand(g, lv(10, 20, 10), 'bb');
  assert.equal(g.dealerSeat, 1);
  assert.equal(g.players[2].bet, 10);
  assert.equal(g.players[3].bet, 20);
});

test('startHand heads-up: the button posts the small blind', () => {
  let g = game(3);
  g = E.eliminate(g, 'p3');
  g = E.startHand(g, lv(10, 20, 10), 'bb');
  const { sbSeat, bbSeat } = E.blindSeats(g);
  assert.equal(sbSeat, g.dealerSeat);
  assert.notEqual(bbSeat, sbSeat);
});

test('antes: big-blind ante goes straight to the pot; classic antes from everyone', () => {
  let g = E.startHand(game(4), lv(10, 20, 10, 20), 'bb');
  assert.equal(g.pot, 20);
  assert.equal(g.players[2].stack, 1000 - 20 - 20);
  g = E.startHand(game(4), lv(10, 20, 10, 5), 'each');
  assert.equal(g.pot, 20);
  assert.equal(E.potTotal(g), 50);
});

test('bets are capped at the stack (all-in) and chips are conserved', () => {
  let g = game(3, 100);
  const before = E.chipsInPlay(g);
  let r = E.placeBet(g, 'p1', 500);
  assert.equal(r.amount, 100);
  g = r.game;
  g = E.callBet(g, 'p2').game;
  assert.equal(g.players[1].bet, 100);
  g = E.awardPot(g, ['p2']);
  assert.equal(E.chipsInPlay(g), before);
  assert.equal(g.players[1].stack, 200);
});

test('split pot: odd chip goes to the first winner left of the button', () => {
  let g = game(4, 100);
  g = E.addToPot(g, 101);
  g.dealerSeat = 2;
  g = E.awardPot(g, ['p1', 'p4']);
  // Clockwise from the button (seat 2): seat 3 (p4) comes before seat 0 (p1).
  assert.equal(g.players[3].stack, 151);
  assert.equal(g.players[0].stack, 150);
});

test('eliminate records finishing place and reinstate undoes it', () => {
  let g = game(4);
  g.players[3].stack = 0;
  g = E.eliminate(g, 'p4');
  assert.equal(g.players[3].place, 4);
  g.players[2].stack = 0;
  g = E.eliminate(g, 'p3');
  assert.equal(g.players[2].place, 3);
  g = E.reinstate(g, 'p4', 500);
  assert.equal(g.players[3].out, false);
  assert.equal(g.players[2].place, 3);
});

test('rebuy of a busted player brings them back with chips', () => {
  let g = game(3);
  g.players[0].stack = 0;
  g = E.eliminate(g, 'p1');
  g = E.rebuy(g, 'p1', 1000);
  assert.equal(g.players[0].out, false);
  assert.equal(g.players[0].stack, 1000);
  assert.equal(g.players[0].rebuys, 1);
});

test('resizePlayers keeps existing stacks', () => {
  const cfg = { playerCount: 4, startingStack: 1000, playerNames: ['A', 'B', 'C', 'D', 'E', 'F'] };
  let g = E.createGame(cfg);
  g.players[0].stack = 1234;
  g = E.resizePlayers(g, { ...cfg, playerCount: 6 });
  assert.equal(g.players.length, 6);
  assert.equal(g.players[0].stack, 1234);
  assert.equal(g.players[5].name, 'F');
  g = E.resizePlayers(g, { ...cfg, playerCount: 2 });
  assert.equal(g.players.length, 2);
});

test('formatting', () => {
  assert.equal(E.formatClock(15 * MIN), '15:00');
  assert.equal(E.formatClock(61 * MIN + 5000), '1:01:05');
  assert.equal(E.formatClock(999), '0:01');
  assert.equal(E.formatChips(1500), '1,500');
  assert.equal(E.formatChips(1500, true), '1.5K');
  assert.equal(E.formatChips(250000, true), '250K');
  assert.equal(E.formatMoney(12.5, '$'), '$12.50');
});
