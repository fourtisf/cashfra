/* Cashfra delete test — a delete has to survive the sync.
 *
 *   node test/deletes.mjs        (no browser, no server, no dependencies)
 *
 * The merge is a union by id, on purpose: losing an edit is recoverable and
 * losing an entry is not. But a union cannot express "this one is gone" — the
 * server still holds the entry, hands it back on the next pull, and the delete
 * undoes itself four seconds after it was made. That is the bug this file
 * guards: tombstones travel with the ledger, and the union's promise still
 * holds for everything that was not deleted.
 *
 * The functions are lifted out of index.html rather than copied, so a change
 * to the merge is tested here rather than drifting away from it.
 */
import { readFileSync } from 'fs';

const SRC = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* pull one top-level `function name(...){...}` out of the app, braces matched */
function span(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('index.html no longer defines ' + name + '()');
  let depth = 0;
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return [at, j + 1];
  }
  throw new Error('unterminated ' + name + '()');
}
const lift = name => SRC.slice(...span(name));
const lineAt = i => SRC.slice(0, i).split('\n').length;
const TTL = /var DEL_TTL=([^;]+);/.exec(SRC);
if (!TTL) throw new Error('index.html no longer defines DEL_TTL');

const NAMES = ['num', 'delMap', 'tombIds', 'untombIds', 'isGone', 'mergeDel',
               'pruneDel', 'applyDel', 'rmTx', 'txIds', 'txSig', 'mergeTx'];
const app = new Function('S', `
  var DEL_TTL=${TTL[1]};
  ${NAMES.map(lift).join('\n')}
  return {${NAMES.join(',')},DEL_TTL:DEL_TTL,S:S};
`);

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const parties = tx => tx.map(t => t.party).sort().join(', ');

const DAY = 864e5;
const T = Date.now();
const entry = (party, mt, extra) => Object.assign(
  { id: party, party, date: '2026-08-01', type: 'in', usd: 100, mt }, extra);

// ── the reported bug ──────────────────────────────────────────────────────
/* One phone, one entry, one delete. The server has not heard about the delete
   yet — it cannot have, the delete is what triggers the push — so its copy
   still has the entry. Before tombstones the very next pull put it back. */
{
  const A = app({});
  const server = [entry('Bebe', T - 60e3), entry('lgbweeed', T - 60e3)];
  A.S.tx = server.slice();
  A.tombIds('Bebe');                                   // ALFA taps Delete
  A.S.tx = A.S.tx.filter(t => t.id !== 'Bebe');
  A.S.tx = A.mergeTx(A.S.tx, server, A.S.del);         // …and the sync pulls
  check(parties(A.S.tx) === 'lgbweeed',
        `a deleted entry does not come back on the next pull (${parties(A.S.tx) || 'empty'})`);
  check(A.S.tx.length === 1, 'and the entries beside it are untouched');
}

// ── the union's promise, kept ─────────────────────────────────────────────
{
  const A = app({});
  A.S.tx = [entry('$ONLY_A', T)];
  const merged = A.mergeTx(A.S.tx, [entry('$ONLY_B', T)], A.S.del);
  check(parties(merged) === '$ONLY_A, $ONLY_B',
        'with nothing deleted the merge is still a union — neither device erases the other');
}

// ── an edit after the delete still wins ───────────────────────────────────
/* The reason the merge never deleted in the first place: work must not be
   eaten. A device that edited the entry AFTER the other one deleted it is
   saying something newer than the tombstone, so it keeps its entry. */
{
  const A = app({});
  A.S.del = { Bebe: T - 30e3 };                        // deleted half a minute ago
  const merged = A.mergeTx([], [entry('Bebe', T)], A.S.del);   // edited just now
  check(parties(merged) === 'Bebe', 'an entry edited after the delete survives it');
  const stale = A.mergeTx([], [entry('Bebe', T - 60e3)], A.S.del);
  check(stale.length === 0, 'an entry last touched before the delete does not');
}

// ── entries from before tombstones existed ────────────────────────────────
/* Sample data and anything logged by an older build carry no `mt` at all.
   A tombstone has to beat that, or the bug survives for exactly the entries
   that have been in the book longest. */
{
  const A = app({});
  A.tombIds('old');
  const merged = A.mergeTx([], [{ id: 'old', party: 'old', date: '2026-01-01' }], A.S.del);
  check(merged.length === 0, 'an entry with no mt at all is still deleted');
}

// ── undo puts it back, against a server that already knows ────────────────
/* The delete has already been pushed, so the tombstone is on the server and
   comes back on the next pull. Undo has to outrank it, not just forget it. */
{
  const A = app({});
  const t = entry('Bebe', T - 60e3);
  A.tombIds('Bebe');
  const pushed = Object.assign({}, A.S.del);           // what the server now holds
  A.untombIds('Bebe', t);                              // ALFA taps Undo
  A.S.tx = [t];
  A.S.del = A.mergeDel(A.S.del, pushed);               // …and the pull brings it back
  const merged = A.mergeTx(A.S.tx, [], A.S.del);
  check(parties(merged) === 'Bebe', 'Undo survives the tombstone the server already has');
}

// ── tombstones themselves merge ───────────────────────────────────────────
{
  const A = app({});
  const both = A.mergeDel({ a: 10, b: 50 }, { b: 20, c: 30 });
  check(both.a === 10 && both.c === 30, 'a tombstone either side has is kept');
  check(both.b === 50, 'and the later time wins where both have one');
  check(A.mergeDel({ a: 1 }, undefined).a === 1, 'a device with no tombstones at all is not a crash');
}

// ── the map does not grow for ever ────────────────────────────────────────
{
  const A = app({});
  A.S.del = { old: T - A.DEL_TTL - DAY, recent: T - DAY };
  check(A.pruneDel() === 1 && A.S.del.recent && !A.S.del.old,
        'tombstones past the TTL are forgotten, recent ones are not');
  check(A.DEL_TTL >= 90 * DAY, `and the TTL is long enough to be away (${Math.round(A.DEL_TTL / DAY)} days)`);
}

// ── a blob written by a build that did not know about tombstones ──────────
{
  const A = app({});
  A.S.tx = [entry('Bebe', T - 60e3), entry('lgbweeed', T)];
  A.S.del = { Bebe: T - 30e3 };
  check(A.applyDel() && parties(A.S.tx) === 'lgbweeed',
        'load sweeps out anything a tombstone has already outlived');
  check(!A.applyDel(), 'and says so only when it actually removed something');
}

// ── S.del survives a shape it should never have ───────────────────────────
{
  const A = app({ del: [] });
  A.delMap();
  check(!Array.isArray(A.S.del) && typeof A.S.del === 'object', 'a malformed S.del is repaired, not trusted');
}

// ── one door out of the book ──────────────────────────────────────────────
/* The fix above is only worth anything while every removal uses it. Two were
   missed the first time — undoing a one-tap recurring log, and the one-time
   sweep of an old build's sample data — and each looked perfectly correct on
   the device it ran on. So this does not test behaviour, it reads the source:
   the only code allowed to take entries out of S.tx is rmTx (which leaves the
   tombstone) and applyDel (which acts on tombstones already made). A new
   removal written any other way fails here, with the line to go and look at. */
{
  const A = app({});
  A.S.tx = [entry('Bebe', T), entry('lgbweeed', T)];
  A.rmTx('Bebe');
  check(parties(A.S.tx) === 'lgbweeed' && A.S.del.Bebe > 0,
        'rmTx takes the entry out and leaves the tombstone in one move');
  A.S.tx = [entry('a', T), entry('b', T), entry('c', T)];
  A.rmTx(['a', 'c']);
  check(parties(A.S.tx) === 'b' && A.S.del.a > 0 && A.S.del.c > 0, 'and does the same for a list');

  const doors = ['rmTx', 'applyDel'].map(span);
  const inside = i => doors.some(([a, b]) => i >= a && i < b);
  const scan = /S\.tx\s*=\s*S\.tx\.filter\(|S\.tx\s*=\s*\[\s*\]|S\.tx\.splice\([^,)]+,\s*(?!0\b)\d/g;
  const strays = [];
  for (let m; (m = scan.exec(SRC));)
    if (!inside(m.index)) strays.push(`index.html:${lineAt(m.index)} ${m[0].trim()}`);
  check(strays.length === 0,
        strays.length ? `entries are removed without a tombstone — call rmTx() instead:\n          ${strays.join('\n          ')}`
                      : 'nothing else in the app takes entries out of the book behind rmTx\u2019s back');
}

// ── the merge is never asked to forget the tombstones ─────────────────────
/* mergeTx still works with two arguments — it is a plain union again, which
   is precisely the old bug. Nothing may call it that way. */
{
  const [defAt, defEnd] = span('mergeTx');
  const calls = [];
  for (let m, re = /mergeTx\(/g; (m = re.exec(SRC));) {
    if (m.index >= defAt && m.index < defEnd) continue;         // the definition itself
    let depth = 0, args = 1, j = m.index + 'mergeTx('.length - 1;
    for (; j < SRC.length; j++) {
      const c = SRC[j];
      if (c === '(' ) depth++;
      else if (c === ')') { if (--depth === 0) break; }
      else if (c === ',' && depth === 1) args++;
    }
    if (args < 3) calls.push(`index.html:${lineAt(m.index)}`);
  }
  check(calls.length === 0,
        calls.length ? `mergeTx() called without the tombstones, which makes it a plain union again: ${calls.join(', ')}`
                     : 'every merge is handed the tombstones \u2014 none of them is a plain union');
}

console.log(ok.map(s => '  PASS  ' + s).join('\n'));
if (bad.length) {
  console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n'));
  process.exit(1);
}
console.log(`\n  ${ok.length} checks, all passing.`);
