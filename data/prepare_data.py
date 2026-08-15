"""
Preprocess bidding_practice.ods into clean JSON for Firestore seeding.

Steps:
1. Read the sheet, split into named sets using header rows (col A non-numeric).
2. Parse S/N hands into {S,H,D,C: "ranks"} dicts.
3. Validate each hand has exactly 13 cards; flag+skip rows that don't.
4. Dedup spot cards (2-9) between S and N per suit:
   - normal spot duplicate: displace the N-hand card, searching upward
     from rank+1, cycling through 2..9, first rank free in BOTH suits.
   - honor duplicate (T,J,Q,K,A repeated between S and N): displace the
     N-hand card to '9' first, then same cyclic 2..9 search if 9 taken.
   Only the N hand is ever edited (S is authoritative), per spec.
5. Parse "Bidding sequence" (thus-far) into seat-tagged tokens:
   dealer = S if first token bare, E if first token parenthesized.
   Rotation order from dealer: S,W,N,E,S,W,N,E,... (from S) or E,S,W,N,... (from E).
   Walk tokens against expected rotation; whenever expected seat is an
   opponent (W/E) but token doesn't match (or list ends), insert a
   silent opponent pass and advance.
6. Suggested column and Notes column kept as raw text (freeform, may
   contain OR / slash alternatives - not tokenized).

Outputs:
  hands.json        - list of sets, each with clean hands
  issues_report.md   - rows excluded + honor/count issues found
"""
import pandas as pd
import json
import re

SRC = '/mnt/user-data/uploads/bidding_practice.ods'
SUITS = ['S', 'H', 'D', 'C']
SPOT_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9']
HONOR_RANKS = ['T', 'J', 'Q', 'K', 'A']
ALL_RANKS_ORDER = {r: i for i, r in enumerate(['2','3','4','5','6','7','8','9','T','J','Q','K','A'])}

df = pd.read_excel(SRC, engine='odf', sheet_name='Sheet1')

# ---------- Manual corrections ----------
# row 49 (Takeout doubles #13): N hand had 14 cards (A765 94 QJ75 JT83) -
# one spade too many. Per instruction, remove one spade spot card from N
# (the '5', lowest spot, least likely to matter) to bring it to 13.
MANUAL_FIXES = {
    49: {'N': 'A76 94 QJ75 JT83'},
}
for idx, col_fixes in MANUAL_FIXES.items():
    for col, val in col_fixes.items():
        df.at[idx, col] = val

# ---------- Step 1: split into named sets ----------
sets = []
current = None
first_col = df.columns[0]  # 'FFB' - also doubles as first set's name

def is_number(v):
    try:
        int(v)
        return True
    except (ValueError, TypeError):
        return False

for i, row in df.iterrows():
    v = row[first_col]
    if pd.isna(v) and all(pd.isna(row[c]) for c in df.columns[1:]):
        continue  # fully blank separator row
    if not is_number(v):
        # header row -> new named set (skip if v is nan, meaning blank row already handled above)
        if pd.isna(v):
            continue
        current = {'name': str(v).strip(), 'hands': []}
        sets.append(current)
        continue
    if current is None:
        # first set's name lives in the column header itself
        current = {'name': str(first_col).strip(), 'hands': []}
        sets.append(current)
    current['hands'].append((i, row))

# ---------- Step 2/3: parse + validate hands ----------
def parse_hand_str(s):
    parts = s.split()
    if len(parts) != 4:
        return None
    return dict(zip(SUITS, parts))

def hand_total(h):
    return sum(len(h[s]) for s in SUITS)

issues = []       # (row_excel_index, reason)
excluded_rows = set()

for st in sets:
    for (i, row) in st['hands']:
        s_raw, n_raw = row['S'], row['N']
        if not isinstance(s_raw, str) or not isinstance(n_raw, str):
            issues.append((i, f"[{st['name']}] missing S or N hand text"))
            excluded_rows.add(i)
            continue
        sh, nh = parse_hand_str(s_raw), parse_hand_str(n_raw)
        if sh is None or nh is None:
            issues.append((i, f"[{st['name']}] hand string not 4 suit-groups: S='{s_raw}' N='{n_raw}'"))
            excluded_rows.add(i)
            continue
        if hand_total(sh) != 13 or hand_total(nh) != 13:
            issues.append((i, f"[{st['name']}] card count != 13 -> S={hand_total(sh)} N={hand_total(nh)} (S='{s_raw}' N='{n_raw}')"))
            excluded_rows.add(i)
            continue

# ---------- Step 4: dedup spot cards (only on rows that passed validation) ----------
def displace(n_list, s_set, n_set, start_rank, pool):
    """Find first rank in pool (list defines cyclic order), starting the
    search AFTER start_rank (cyclically), not present in s_set or n_set."""
    if start_rank in pool:
        start_idx = pool.index(start_rank)
        order = pool[start_idx+1:] + pool[:start_idx+1]
    else:
        order = pool
    for cand in order:
        if cand not in s_set and cand not in n_set:
            return cand
    return None  # shouldn't happen given only 2 of 4 hands are populated

def dedup_hand_pair(sh, nh, row_label):
    notes = []
    for suit in SUITS:
        s_chars = list(sh[suit])
        n_chars = list(nh[suit])
        changed = True
        guard = 0
        while changed and guard < 50:
            changed = False
            guard += 1
            s_set, n_set = set(s_chars), set(n_chars)
            dup = s_set & n_set
            if not dup:
                break
            # process one duplicate at a time (re-scan after each fix)
            d = sorted(dup, key=lambda r: ALL_RANKS_ORDER.get(r, 99))[0]
            idx = n_chars.index(d)  # first occurrence in N hand
            if d in SPOT_RANKS:
                new_rank = displace(n_chars, s_set, n_set, d, SPOT_RANKS)
            else:
                # honor duplicate -> shift to '9' first, then cyclic 2..9 search
                new_rank = displace(n_chars, s_set, n_set, '8', SPOT_RANKS)  # search starts AFTER '8' -> '9' first
            if new_rank is None:
                notes.append(f"{row_label} suit {suit}: could not resolve duplicate '{d}' (suit full)")
                break
            n_chars[idx] = new_rank
            notes.append(f"{row_label} suit {suit}: N-hand duplicate '{d}' -> '{new_rank}'")
            changed = True
        nh[suit] = ''.join(n_chars)
    return notes

dedup_log = []
cleaned_hands = {}  # row index -> (sh, nh) after dedup
for st in sets:
    for (i, row) in list(st['hands']):
        if i in excluded_rows:
            continue
        sh = parse_hand_str(row['S'])
        nh = parse_hand_str(row['N'])
        log = dedup_hand_pair(sh, nh, f"[{st['name']} #{row['FFB']}] row{i}")
        dedup_log.extend(log)
        cleaned_hands[i] = (sh, nh)

# ---------- Step 5: parse bidding sequence into seat-tagged tokens ----------
def parse_thus_far(bs):
    """Returns (dealer, tokens) where tokens is a list of
    {seat, call, isOpp}. Also inserts silent opponent-pass entries
    where the rotation skips an opponent seat."""
    if not isinstance(bs, str) or not bs.strip():
        return 'S', []
    raw_toks = bs.split()
    first_opp = raw_toks[0].startswith('(')
    dealer = 'E' if first_opp else 'S'
    order_from_S = ['S', 'W', 'N', 'E']
    order_from_E = ['E', 'S', 'W', 'N']
    order = order_from_E if dealer == 'E' else order_from_S

    result = []
    ptr = 0  # index into rotation order (mod 4)
    for tok in raw_toks:
        is_opp_tok = tok.startswith('(') and tok.endswith(')')
        call = tok[1:-1] if is_opp_tok else tok
        seat = order[ptr % 4]
        seat_is_opp = seat in ('W', 'E')
        # if expected seat is opponent but token isn't an opponent token,
        # that opponent silently passed - advance and insert a pass entry
        if seat_is_opp and not is_opp_tok:
            result.append({'seat': seat, 'call': 'P', 'isOpp': True, 'implicit': True})
            ptr += 1
            seat = order[ptr % 4]
            seat_is_opp = seat in ('W', 'E')
        result.append({'seat': seat, 'call': call, 'isOpp': seat_is_opp, 'implicit': False})
        ptr += 1
    return dealer, result

# ---------- Assemble output ----------
out_sets = []
for st in sets:
    hands_out = []
    for (i, row) in st['hands']:
        if i in excluded_rows:
            continue
        sh, nh = cleaned_hands[i]
        dealer, tokens = parse_thus_far(row['Bidding sequence'])
        suggested = row['Suggested'] if isinstance(row['Suggested'], str) else ''
        notes = row['Unnamed: 5'] if isinstance(row['Unnamed: 5'], str) else ''
        hands_out.append({
            'num': int(row['FFB']),
            'sHand': sh,
            'nHand': nh,
            'dealer': dealer,
            'thusFar': tokens,
            'suggested': suggested.strip(),
            'notes': notes.strip(),
        })
    out_sets.append({'name': st['name'], 'hands': hands_out})

with open('/home/claude/bridge-app/data/hands.json', 'w') as f:
    json.dump({'sets': out_sets}, f, indent=2)

with open('/home/claude/bridge-app/data/issues_report.md', 'w') as f:
    f.write('# Data issues report\n\n')
    f.write(f'## Excluded rows ({len(excluded_rows)}) - fix in source sheet and re-import\n\n')
    for i, reason in issues:
        f.write(f'- row {i}: {reason}\n')
    f.write(f'\n## Spot/honor card displacements applied ({len(dedup_log)})\n\n')
    for line in dedup_log:
        f.write(f'- {line}\n')

total_hands = sum(len(s['hands']) for s in out_sets)
print(f"Sets: {[ (s['name'], len(s['hands'])) for s in out_sets ]}")
print(f"Total clean hands: {total_hands}")
print(f"Excluded rows: {len(excluded_rows)}")
print(f"Displacements applied: {len(dedup_log)}")
