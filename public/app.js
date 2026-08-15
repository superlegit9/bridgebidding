import { db, auth, ready } from './firebase-init.js';
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot,
  query, orderBy, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { initAuctionState, applyLiveCall, legalCalls, formatCall, formatContract, STRAIN_SYMBOL } from './auction.js';

const viewEl = document.getElementById('view');
const sessionMetaEl = document.getElementById('sessionMeta');
const toastEl = document.getElementById('toast');
const STORAGE_KEY = 'bridgePracticeSession';

let myUid = null;
const handCache = new Map(); // `${setId}/${num}` -> hand doc data

function toast(msg, ms = 3200) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 ambiguity
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function saveLocal(code, name, role) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, name, role }));
}
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function clearLocal() { localStorage.removeItem(STORAGE_KEY); }

// ---------- boot ----------
ready.then((uid) => {
  myUid = uid;
  const saved = loadLocal();
  if (saved) {
    enterGame(saved.code, saved.name, saved.role);
  } else {
    renderLanding();
  }
});

// ---------- landing ----------
async function renderLanding() {
  sessionMetaEl.classList.add('hidden');
  viewEl.innerHTML = `
    <div class="landing">
      <p class="tagline">Bidding practice for partnerships. Two seats, one auction, no peeking.</p>
      <div class="tabs">
        <button class="tab-btn active" data-tab="start">Start a session</button>
        <button class="tab-btn" data-tab="join">Join a session</button>
      </div>

      <section id="startPane" class="pane">
        <label>Your name<input id="hostName" type="text" maxlength="30" placeholder="e.g. Alice"></label>
        <label>Partner's name<input id="partnerName" type="text" maxlength="30" placeholder="e.g. Bob"></label>
        <label>Set to practice
          <select id="setSelect"><option>Loading sets&hellip;</option></select>
        </label>
        <button id="createBtn" class="primary">Create session</button>
      </section>

      <section id="joinPane" class="pane hidden">
        <label>Session code<input id="joinCode" type="text" maxlength="6" style="text-transform:uppercase" placeholder="e.g. K7QX2M"></label>
        <label>Your name<input id="joinName" type="text" maxlength="30" placeholder="the name your partner entered for you"></label>
        <button id="joinBtn" class="primary">Join session</button>
      </section>
    </div>
  `;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const which = btn.dataset.tab;
      document.getElementById('startPane').classList.toggle('hidden', which !== 'start');
      document.getElementById('joinPane').classList.toggle('hidden', which !== 'join');
    });
  });

  // load sets
  const setSelect = document.getElementById('setSelect');
  const setsSnap = await getDocs(query(collection(db, 'sets'), orderBy('order')));
  if (setsSnap.empty) {
    setSelect.innerHTML = `<option value="">No sets found - seed the database first (see README)</option>`;
  } else {
    setSelect.innerHTML = setsSnap.docs
      .map((d) => `<option value="${d.id}">${d.data().name} (${d.data().handCount} hands)</option>`)
      .join('');
  }

  document.getElementById('createBtn').addEventListener('click', async () => {
    const hostName = document.getElementById('hostName').value.trim();
    const partnerName = document.getElementById('partnerName').value.trim();
    const setId = setSelect.value;
    if (!hostName || !partnerName) return toast('Enter both names.');
    if (hostName.toLowerCase() === partnerName.toLowerCase()) return toast('Names must be different.');
    if (!setId) return toast('Choose a set.');

    const setDocSnap = await getDoc(doc(db, 'sets', setId));
    if (!setDocSnap.exists()) return toast('That set is missing from the database.');
    const handNums = setDocSnap.data().handNums;

    let code = genCode();
    for (let i = 0; i < 5; i++) {
      const exists = (await getDoc(doc(db, 'sessions', code))).exists();
      if (!exists) break;
      code = genCode();
    }
    await setDoc(doc(db, 'sessions', code), {
      hostName, partnerName,
      setId, setName: setDocSnap.data().name,
      hostUid: myUid, partnerUid: null,
      handNums, currentPos: 0,
      createdAt: serverTimestamp(),
    });
    saveLocal(code, hostName, 'host');
    toast(`Session created: ${code}`);
    enterGame(code, hostName, 'host');
  });

  document.getElementById('joinBtn').addEventListener('click', async () => {
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    const name = document.getElementById('joinName').value.trim();
    if (!code || !name) return toast('Enter the session code and your name.');

    const sref = doc(db, 'sessions', code);
    const snap = await getDoc(sref);
    if (!snap.exists()) return toast('No session found with that code.');
    const s = snap.data();

    let role = null;
    if (name.toLowerCase() === s.hostName.toLowerCase()) role = 'host';
    else if (name.toLowerCase() === s.partnerName.toLowerCase()) role = 'partner';
    else return toast("That name wasn't used to start this session.");

    await updateDoc(sref, role === 'host' ? { hostUid: myUid } : { partnerUid: myUid });
    saveLocal(code, name, role);
    enterGame(code, name, role);
  });
}

// ---------- game ----------
async function enterGame(code, myName, role) {
  sessionMetaEl.classList.remove('hidden');
  sessionMetaEl.innerHTML = `<span class="code-pill">${code}</span> <button id="leaveBtn" class="link-btn">Leave session</button>`;
  document.getElementById('leaveBtn').addEventListener('click', () => {
    clearLocal();
    renderLanding();
  });

  const sref = doc(db, 'sessions', code);
  let unsubHand = null;

  onSnapshot(sref, async (snap) => {
    if (!snap.exists()) {
      toast('Session no longer exists.');
      clearLocal();
      return renderLanding();
    }
    const session = snap.data();
    if (unsubHand) { unsubHand(); unsubHand = null; }
    unsubHand = await renderHandForSession(code, session, myName, role);
  });
}

async function getHand(setId, num) {
  const key = `${setId}/${num}`;
  if (handCache.has(key)) return handCache.get(key);
  const snap = await getDoc(doc(db, 'sets', setId, 'hands', String(num)));
  const data = snap.data();
  handCache.set(key, data);
  return data;
}

async function renderHandForSession(code, session, myName, role) {
  const { handNums, currentPos, setId, setName, hostName, partnerName, hostUid, partnerUid } = session;

  if (currentPos >= handNums.length) {
    viewEl.innerHTML = `
      <div class="complete">
        <h1>Set complete</h1>
        <p>You and ${role === 'host' ? partnerName : hostName} finished every hand in "${setName}".</p>
        <button id="backBtn" class="primary">Back to start</button>
      </div>`;
    document.getElementById('backBtn').addEventListener('click', () => { clearLocal(); renderLanding(); });
    return null;
  }

  if (!hostUid || !partnerUid) {
    const waitingFor = !hostUid ? hostName : partnerName;
    viewEl.innerHTML = `
      <div class="waiting">
        <h1>Waiting for ${waitingFor}</h1>
        <p>Share this code so they can join: <span class="code-pill big">${code}</span></p>
        <p class="muted">They should choose "Join a session" and enter this code with the name you gave them.</p>
      </div>`;
    return null;
  }

  const hostSeat = currentPos % 2 === 0 ? 'S' : 'N';
  const partnerSeat = hostSeat === 'S' ? 'N' : 'S';
  const mySeat = role === 'host' ? hostSeat : partnerSeat;
  const otherName = role === 'host' ? partnerName : hostName;
  const sName = hostSeat === 'S' ? hostName : partnerName;
  const nName = hostSeat === 'N' ? hostName : partnerName;

  const num = handNums[currentPos];
  const hand = await getHand(setId, num);

  const hsRef = doc(db, 'sessions', code, 'handStates', String(currentPos));
  let unsub = null;

  await ensureHandStateExists(hsRef, hand, sName, nName,
    hostSeat === 'S' ? hostUid : partnerUid,
    hostSeat === 'N' ? hostUid : partnerUid);

  unsub = onSnapshot(hsRef, (snap) => {
    if (!snap.exists()) return;
    const hs = snap.data();
    renderGameScreen({
      code, session, hand, hsRef, hs, num, currentPos, total: handNums.length,
      mySeat, myName, otherName, sName, nName, setName,
    });
  });

  return unsub;
}

async function ensureHandStateExists(hsRef, hand, sName, nName, sUid, nUid) {
  const snap = await getDoc(hsRef);
  if (snap.exists()) return;
  try {
    await setDoc(hsRef, { sName, nName, sUid, nUid, liveCalls: [], revealed: false }, { merge: false });
  } catch (e) {
    // benign race: the other client created it first
  }
}

function computeAuction(hand, liveCalls) {
  let state = initAuctionState(hand);
  for (const c of liveCalls) state = applyLiveCall(state, c.call);
  return state;
}

function renderGameScreen(ctx) {
  const { hand, hsRef, hs, num, currentPos, total, mySeat, otherName, sName, nName, setName } = ctx;
  const state = computeAuction(hand, hs.liveCalls || []);
  const isMyTurn = !state.over && state.turnSeat === mySeat;

  if (state.over && !hs.revealed) {
    updateDoc(hsRef, { revealed: true }).catch(() => {});
  }

  const myHand = mySeat === 'S' ? hand.sHand : hand.nHand;
  const otherSeat = mySeat === 'S' ? 'N' : 'S';

  viewEl.innerHTML = `
    <div class="game">
      <div class="hand-header">
        <div><span class="set-label">${setName}</span> &middot; hand ${currentPos + 1} of ${total}</div>
        <div class="seat-badge">You are <strong>${mySeat === 'S' ? 'South' : 'North'}</strong></div>
      </div>

      <div class="table-layout">
        <div class="hand-panel mine">
          <h2>Your hand</h2>
          ${renderHandSuits(myHand)}
        </div>

        <div class="auction-panel">
          <table class="auction-table">
            <thead><tr><th>N</th><th>E</th><th>S</th><th>W</th></tr></thead>
            <tbody>${renderAuctionRows(state.full)}</tbody>
          </table>
          ${state.over
            ? `<div class="contract-line">${formatContract(state.contract)}</div>`
            : isMyTurn
              ? `<div class="turn-line mine">Your bid</div>`
              : `<div class="turn-line">Waiting for ${otherName}&hellip;</div>`
          }
        </div>

        <div class="hand-panel other ${state.over ? '' : 'blurred'}">
          <h2>${otherSeat === 'S' ? sName : nName}'s hand</h2>
          ${state.over ? renderHandSuits(otherSeat === 'S' ? hand.sHand : hand.nHand) : `<div class="locked">Revealed once the auction ends</div>`}
        </div>
      </div>

      ${isMyTurn ? renderBidBox(state) : ''}

      ${state.over ? renderReveal(ctx, state) : ''}
    </div>
  `;

  if (isMyTurn) wireBidBox(hsRef, hs, state);
  if (state.over) wireReveal(ctx);
}

function renderHandSuits(h) {
  return `
    <div class="suit-row"><i class="s">&spades;</i>${h.S || '&mdash;'}</div>
    <div class="suit-row"><i class="h">&hearts;</i>${h.H || '&mdash;'}</div>
    <div class="suit-row"><i class="d">&diams;</i>${h.D || '&mdash;'}</div>
    <div class="suit-row"><i class="c">&clubs;</i>${h.C || '&mdash;'}</div>
  `;
}

function renderAuctionRows(full) {
  // arrange into N E S W columns, chronological rows, starting column = whichever seat leads
  const seatCol = { N: 0, E: 1, S: 2, W: 3 };
  const rows = [];
  let row = [null, null, null, null];
  let started = false;
  for (const call of full) {
    const col = seatCol[call.seat];
    if (!started) {
      // pad leading seats with blank cells before the first caller
      for (let c = 0; c < col; c++) row[c] = '';
      started = true;
    }
    row[col] = formatCallHtml(call.call);
    if (col === 3) { rows.push(row); row = [null, null, null, null]; }
  }
  if (row.some((c) => c !== null)) {
    for (let c = 0; c < 4; c++) if (row[c] === null) row[c] = '';
    rows.push(row);
  }
  return rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
}

function formatCallHtml(call) {
  if (call === 'P') return '<span class="call pass">Pass</span>';
  if (call === 'X') return '<span class="call dbl">X</span>';
  if (call === 'XX') return '<span class="call dbl">XX</span>';
  const strain = call[1];
  const cls = strain === 'H' || strain === 'D' ? 'red' : 'black';
  return `<span class="call ${cls}">${call[0]}${STRAIN_SYMBOL[strain]}</span>`;
}

function renderBidBox(state) {
  const legal = legalCalls(state);
  const strains = ['C', 'D', 'H', 'S', 'N'];
  let grid = '';
  for (let level = 1; level <= 7; level++) {
    grid += `<div class="bid-row">`;
    for (const st of strains) {
      const call = `${level}${st}`;
      const disabled = !isCallLegal(call, state) ? 'disabled' : '';
      const cls = st === 'H' || st === 'D' ? 'red' : 'black';
      grid += `<button class="bid-btn ${cls}" data-call="${call}" ${disabled}>${level}${STRAIN_SYMBOL[st]}</button>`;
    }
    grid += `</div>`;
  }
  return `
    <div class="bid-box">
      <div class="bid-grid">${grid}</div>
      <div class="bid-actions">
        <button class="action-btn pass" data-call="P">Pass</button>
        <button class="action-btn dbl" data-call="X" ${legal.double ? '' : 'disabled'}>Double</button>
        <button class="action-btn dbl" data-call="XX" ${legal.redouble ? '' : 'disabled'}>Redouble</button>
      </div>
    </div>
  `;
}

function isCallLegal(call, state) {
  const c = state.contract;
  if (c.level === null) return true;
  const rank = { C: 0, D: 1, H: 2, S: 3, N: 4 };
  const level = parseInt(call[0], 10), strain = call[1];
  return level > c.level || (level === c.level && rank[strain] > rank[c.strain]);
}

function wireBidBox(hsRef, hs, state) {
  document.querySelectorAll('.bid-btn:not([disabled]), .action-btn:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const call = btn.dataset.call;
      document.querySelectorAll('.bid-btn, .action-btn').forEach((b) => b.disabled = true);
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(hsRef);
          const current = snap.data();
          const currentLive = current.liveCalls || [];
          if (currentLive.length !== (hs.liveCalls || []).length) {
            throw new Error('stale'); // someone else already acted; let onSnapshot resync
          }
          tx.update(hsRef, { liveCalls: [...currentLive, { seat: state.turnSeat, call }] });
        });
      } catch (e) {
        if (e.message !== 'stale') toast('Could not submit that call - try again.');
      }
    });
  });
}

function renderReveal(ctx, state) {
  const { hand } = ctx;
  return `
    <div class="reveal">
      <div class="reveal-hands">
        <div class="hand-panel"><h2>South</h2>${renderHandSuits(hand.sHand)}</div>
        <div class="hand-panel"><h2>North</h2>${renderHandSuits(hand.nHand)}</div>
      </div>
      ${hand.suggested ? `<div class="suggested"><h3>Suggested sequence</h3><p>${escapeHtml(hand.suggested)}</p></div>` : ''}
      ${hand.notes ? `<div class="notes"><h3>Notes</h3><p>${escapeHtml(hand.notes)}</p></div>` : ''}
      <button id="nextHandBtn" class="primary">Next hand</button>
    </div>
  `;
}

function wireReveal(ctx) {
  const btn = document.getElementById('nextHandBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const sref = doc(db, 'sessions', ctx.code);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(sref);
        const s = snap.data();
        if (s.currentPos !== ctx.currentPos) return; // already advanced by other client
        tx.update(sref, { currentPos: ctx.currentPos + 1 });
      });
    } catch (e) {
      toast('Could not advance - try again.');
      btn.disabled = false;
    }
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
