// Bidding auction engine. Pure functions, no DOM/Firestore dependencies,
// so it can be unit-tested independently of the app shell.

const STRAIN_RANK = { C: 0, D: 1, H: 2, S: 3, N: 4 };
const STRAIN_SYMBOL = { C: '\u2663', D: '\u2666', H: '\u2665', S: '\u2660', N: 'NT' };
const ROTATION_FROM_S = ['S', 'W', 'N', 'E'];
const ROTATION_FROM_E = ['E', 'S', 'W', 'N'];

function seatSide(seat) {
  return (seat === 'S' || seat === 'N') ? 'us' : 'opp';
}

function rotationOrder(dealer) {
  return dealer === 'E' ? ROTATION_FROM_E : ROTATION_FROM_S;
}

// Replays a full call list (thusFar tokens, each {seat,call}) and returns
// the auction's running state: contract, doubled status, trailing pass streak.
function replay(dealer, tokens) {
  let level = null, strain = null, side = null, doubled = 'none';
  let passStreak = 0;
  for (const t of tokens) {
    const call = t.call;
    if (call === 'P') {
      passStreak += 1;
      continue;
    }
    passStreak = 0;
    if (call === 'X') { doubled = 'X'; continue; }
    if (call === 'XX') { doubled = 'XX'; continue; }
    level = parseInt(call[0], 10);
    strain = call[1];
    side = seatSide(t.seat);
    doubled = 'none';
  }
  return { level, strain, side, doubled, passStreak };
}

// Given dealer + tokens consumed so far, find the pointer position (index
// into rotation order) for the NEXT seat to act.
function pointerAfter(tokens) {
  return tokens.length;
}

// Build the initial live-auction state from a hand's precomputed dealer +
// thusFar tokens (already includes any implicit opponent-pass entries).
function initAuctionState(hand) {
  const dealer = hand.dealer;
  const order = rotationOrder(dealer);
  const thusFar = hand.thusFar.map(t => ({ seat: t.seat, call: t.call, isOpp: t.isOpp }));
  let ptr = pointerAfter(thusFar);

  // Walk forward, auto-inserting opponent passes, until we reach a live seat.
  const full = thusFar.slice();
  while (seatSide(order[ptr % 4]) === 'opp') {
    full.push({ seat: order[ptr % 4], call: 'P', isOpp: true, implicit: true });
    ptr += 1;
  }
  const turnSeat = order[ptr % 4];
  const r = replay(dealer, full);
  return {
    dealer,
    order,
    full,          // full call list including all auto-inserted opponent passes
    liveCalls: [],  // just the calls the live players actually typed (for UI history + partner-pass rule)
    turnSeat,
    ptr,
    contract: { level: r.level, strain: r.strain, side: r.side, doubled: r.doubled },
    passStreak: r.passStreak,
    over: r.passStreak >= 3,
  };
}

// Returns which calls are legal for the current live player.
function legalCalls(state) {
  if (state.over) return { pass: false, double: false, redouble: false, minBid: null };
  const c = state.contract;
  const mySide = seatSide(state.turnSeat);
  const canDouble = c.level !== null && c.side !== mySide && c.doubled === 'none';
  const canRedouble = c.level !== null && c.side !== mySide && c.doubled === 'X';
  return { pass: true, double: canDouble, redouble: canRedouble, contract: c };
}

function isBidHigher(level, strain, contract) {
  if (contract.level === null) return true;
  const a = [level, STRAIN_RANK[strain]];
  const b = [contract.level, STRAIN_RANK[contract.strain]];
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

// Apply a live call ('P', 'X', 'XX', or e.g. '3H') made by the current
// turnSeat. Returns a NEW state object (does not mutate).
function applyLiveCall(state, call) {
  if (state.over) throw new Error('Auction already over');
  const seat = state.turnSeat;
  const legal = legalCalls(state);
  if (call === 'P' && !legal.pass) throw new Error('Pass not legal');
  if (call === 'X' && !legal.double) throw new Error('Double not legal');
  if (call === 'XX' && !legal.redouble) throw new Error('Redouble not legal');
  if (!['P', 'X', 'XX'].includes(call)) {
    const level = parseInt(call[0], 10);
    const strain = call[1];
    if (!isBidHigher(level, strain, state.contract)) throw new Error('Bid too low');
  }

  const wasPartnerNonPass = state.liveCalls.length > 0 &&
    state.liveCalls[state.liveCalls.length - 1].call !== 'P';

  const newLiveCalls = state.liveCalls.concat([{ seat, call }]);
  const newFull = state.full.concat([{ seat, call, isOpp: false, implicit: false }]);

  let ptr = state.ptr + 1;
  const order = state.order;
  // guaranteed single opponent auto-pass follows every live call
  const oppSeat = order[ptr % 4];
  newFull.push({ seat: oppSeat, call: 'P', isOpp: true, implicit: true });
  ptr += 1;
  const nextTurnSeat = order[ptr % 4];

  const r = replay(state.dealer, newFull);
  const over = r.passStreak >= 3;

  return {
    ...state,
    full: newFull,
    liveCalls: newLiveCalls,
    turnSeat: nextTurnSeat,
    ptr,
    contract: { level: r.level, strain: r.strain, side: r.side, doubled: r.doubled },
    passStreak: r.passStreak,
    over,
    endedByPartnerPass: call === 'P' && wasPartnerNonPass && over,
  };
}

function formatCall(call) {
  if (call === 'P') return 'Pass';
  if (call === 'X') return 'X';
  if (call === 'XX') return 'XX';
  return call[0] + STRAIN_SYMBOL[call[1]];
}

function formatContract(contract) {
  if (contract.level === null) return 'Passed out';
  const dbl = contract.doubled === 'X' ? ' X' : contract.doubled === 'XX' ? ' XX' : '';
  return `${contract.level}${STRAIN_SYMBOL[contract.strain]}${dbl} by ${contract.side === 'us' ? 'us' : 'opponents'}`;
}

export { initAuctionState, applyLiveCall, legalCalls, formatCall, formatContract, seatSide, STRAIN_SYMBOL, STRAIN_RANK };

if (typeof module !== 'undefined') {
  module.exports = { initAuctionState, applyLiveCall, legalCalls, formatCall, formatContract, seatSide, STRAIN_SYMBOL, STRAIN_RANK };
}
