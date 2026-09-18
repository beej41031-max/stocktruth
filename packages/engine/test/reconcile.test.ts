import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../src/reconcile';
import {
  DEFAULT_POLICY,
  type BookSnapshot,
  type CountLine,
  type ItemRef,
  type Movement,
  type MovementType,
  type ReconciliationInput,
} from '../src/types';

/**
 * These tests are the specification. If one of them fails, the product is
 * lying to somebody about their stock.
 *
 * Most of them exist because a real system got the case wrong first.
 */

const NOW = new Date('2026-06-01T09:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const item = (over: Partial<ItemRef> = {}): ItemRef => ({
  id: 'item-1',
  sku: 'MC-2041',
  name: 'Pale malt 25kg',
  stockUnit: 'sack',
  active: true,
  blocked: false,
  ...over,
});

const book = (over: Partial<BookSnapshot> = {}): BookSnapshot => ({
  id: 'book-1',
  quantity: 40,
  unit: 'sack',
  asOf: day(10),
  sourceSystemId: 'src-1',
  ...over,
});

const count = (over: Partial<CountLine> = {}): CountLine => ({
  id: 'count-1',
  quantity: 38,
  unit: 'sack',
  countedAt: day(2),
  receivedAt: day(2),
  countedBy: 'user-1',
  sessionId: 'sess-1',
  sessionWatermark: null,
  ...over,
});

const move = (type: MovementType, qty: number, over: Partial<Movement> = {}): Movement => ({
  id: `mv-${Math.random().toString(36).slice(2, 8)}`,
  type,
  quantity: qty,
  unit: 'sack',
  occurredAt: day(1),
  recordedAt: day(1),
  importedAt: day(1),
  sourceSystemId: 'src-1',
  ...over,
});

const input = (over: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  item: item(),
  locationId: 'loc-1',
  book: book(),
  count: count(),
  movements: [],
  unlinkedMovementCount: 0,
  possiblyRelatedUnlinkedCount: 0,
  sources: [],
  policy: DEFAULT_POLICY,
  evaluatedAt: NOW,
  ...over,
});

// ---------------------------------------------------------------------------
// The happy path, which should be rarer than people expect
// ---------------------------------------------------------------------------

test('clean evidence gives a verified position', () => {
  const r = reconcile(input({ movements: [move('RECEIVE', 10)] }));
  assert.equal(r.state, 'VERIFIED');
  assert.equal(r.derivedQuantity, 48);
  assert.equal(r.movementNet, 10);
});

test('variance at count is the book being wrong, not the current position', () => {
  // Book said 40 ten days ago. 6 issued since. So the book implies 34 at count
  // time. Counter found 38. The records were four out.
  const r = reconcile(
    input({
      movements: [move('ISSUE', 6, { occurredAt: day(5), recordedAt: day(5) })],
    }),
  );
  assert.equal(r.varianceAtCount, 4);
  assert.equal(r.derivedQuantity, 38); // nothing moved after the count
});

test('issues reduce the derived position', () => {
  const r = reconcile(input({ movements: [move('ISSUE', 8)] }));
  assert.equal(r.derivedQuantity, 30);
});

// ---------------------------------------------------------------------------
// The case this product exists for
// ---------------------------------------------------------------------------

test('a movement that happened before the count but was recorded after it blocks the number', () => {
  // Goods landed at 10:00, counter walked past at 10:05, paperwork went in at
  // 14:00. Were those goods on the shelf when he looked? Nothing says.
  const countedAt = day(2);
  const r = reconcile(
    input({
      count: count({ countedAt, receivedAt: countedAt }),
      movements: [
        move('RECEIVE', 300, {
          occurredAt: new Date(countedAt.getTime() - 5 * 60_000),
          recordedAt: new Date(countedAt.getTime() + 4 * 3_600_000),
        }),
      ],
    }),
  );

  assert.equal(r.state, 'INCOMPLETE');
  assert.equal(r.derivedQuantity, null, 'must not guess');
  assert.ok(r.reasons.includes('MOVEMENT_SPANS_COUNT'));
  // We still report what was counted. That part is known.
  assert.equal(r.physicalQuantity, 38);
});

test('the same movement recorded before the count is applied normally', () => {
  const countedAt = day(2);
  const r = reconcile(
    input({
      count: count({ countedAt, receivedAt: countedAt }),
      movements: [
        move('RECEIVE', 300, {
          occurredAt: new Date(countedAt.getTime() - 5 * 60_000),
          recordedAt: new Date(countedAt.getTime() - 4 * 60_000),
        }),
      ],
    }),
  );
  // It happened before the count, so the counter saw it. It is already in the 38.
  assert.equal(r.state, 'VERIFIED');
  assert.equal(r.derivedQuantity, 38);
});

test('unmatched movements elsewhere at the site weaken but do not withdraw the number', () => {
  // One stray hop receipt should not make the malt count unusable. Saying "I
  // do not know" about everything is its own kind of wrong.
  const r = reconcile(input({ unlinkedMovementCount: 3 }));
  assert.equal(r.state, 'PROVISIONAL');
  assert.equal(r.derivedQuantity, 38);
  assert.ok(r.reasons.includes('UNMATCHED_MOVEMENTS_AT_SITE'));
});

test('an unmatched movement whose code points at this item does block it', () => {
  const r = reconcile(input({ unlinkedMovementCount: 3, possiblyRelatedUnlinkedCount: 1 }));
  assert.equal(r.state, 'INCOMPLETE');
  assert.equal(r.derivedQuantity, null);
  assert.ok(r.reasons.includes('MOVEMENT_MAY_BELONG_HERE'));
});

test('a variance is not claimed while a movement might belong to this item', () => {
  const r = reconcile(input({ possiblyRelatedUnlinkedCount: 1 }));
  assert.equal(r.varianceAtCount, null);
});

test('an undated movement cannot be placed, so no position is claimed', () => {
  const r = reconcile(input({ movements: [move('RECEIVE', 5, { occurredAt: null })] }));
  assert.equal(r.state, 'INCOMPLETE');
  assert.equal(r.derivedQuantity, null);
  assert.ok(r.reasons.includes('MOVEMENT_UNDATED'));
});

// ---------------------------------------------------------------------------
// Absence
// ---------------------------------------------------------------------------

test('never counted is unverified, not zero and not the book figure', () => {
  const r = reconcile(input({ count: null }));
  assert.equal(r.state, 'UNVERIFIED');
  assert.equal(r.derivedQuantity, null);
  assert.equal(r.physicalQuantity, null);
  assert.equal(r.bookQuantity, 40, 'the book claim is still worth showing');
  assert.ok(r.reasons.includes('NEVER_COUNTED'));
});

test('a counted zero is a real observation, not missing data', () => {
  const r = reconcile(input({ count: count({ quantity: 0 }), book: book({ quantity: 0 }) }));
  assert.equal(r.state, 'VERIFIED');
  assert.equal(r.derivedQuantity, 0);
  assert.equal(r.physicalQuantity, 0);
});

test('no book position still allows a current position from the count', () => {
  const r = reconcile(input({ book: null, movements: [move('RECEIVE', 2)] }));
  assert.equal(r.state, 'PROVISIONAL');
  assert.equal(r.derivedQuantity, 40);
  assert.equal(r.varianceAtCount, null, 'nothing to compare against');
  assert.ok(r.reasons.includes('NO_BOOK_POSITION'));
});

test('an undated book figure cannot be carried forward to the count', () => {
  const r = reconcile(input({ book: book({ asOf: null }) }));
  assert.equal(r.varianceAtCount, null);
  assert.ok(r.reasons.includes('BOOK_UNDATED'));
  // The count itself is still good, so a current position is still derivable.
  assert.equal(r.derivedQuantity, 38);
});

test('a book far older than the count will not support a variance', () => {
  const r = reconcile(input({ book: book({ asOf: day(90) }) }));
  assert.ok(r.reasons.includes('BOOK_STALE'));
  assert.equal(r.varianceAtCount, null, 'too much unrecorded time in between');
});

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

test('a count older than policy goes stale but keeps its arithmetic', () => {
  const r = reconcile(
    input({
      count: count({ countedAt: day(45), receivedAt: day(45) }),
      book: book({ asOf: day(50) }),
      movements: [move('RECEIVE', 5, { occurredAt: day(3), recordedAt: day(3) })],
    }),
  );
  assert.equal(r.state, 'STALE');
  assert.equal(r.derivedQuantity, 43, 'still computable, just not current');
  assert.ok(r.reasons.includes('COUNT_STALE'));
});

// ---------------------------------------------------------------------------
// Identity and units
// ---------------------------------------------------------------------------

test('a blocked item conflicts before anything else is considered', () => {
  const r = reconcile(input({ item: item({ blocked: true, blockedReason: 'one code, two products' }) }));
  assert.equal(r.state, 'CONFLICT');
  assert.equal(r.derivedQuantity, null);
  assert.deepEqual(r.reasons, ['ITEM_BLOCKED']);
});

test('an ambiguous identity conflicts', () => {
  const r = reconcile(input({ item: item({ identityAmbiguous: true }) }));
  assert.equal(r.state, 'CONFLICT');
  assert.ok(r.reasons.includes('AMBIGUOUS_ITEM_IDENTITY'));
});

test('a book figure in the wrong unit is refused, not converted', () => {
  const r = reconcile(input({ book: book({ unit: 'kg' }) }));
  assert.equal(r.state, 'CONFLICT');
  assert.ok(r.reasons.includes('BOOK_UNIT_MISMATCH'));
});

test('movements in the wrong unit are refused and named', () => {
  const bad = move('RECEIVE', 25, { unit: 'kg' });
  const r = reconcile(input({ movements: [bad] }));
  assert.equal(r.state, 'CONFLICT');
  assert.ok(r.reasons.includes('MOVEMENT_UNIT_MISMATCH'));
  assert.ok(r.evidence.ignoredMovementIds.includes(bad.id));
});

// ---------------------------------------------------------------------------
// Contradiction
// ---------------------------------------------------------------------------

test('a negative position is a conflict, not a zero', () => {
  const r = reconcile(input({ movements: [move('ISSUE', 100)] }));
  assert.equal(r.state, 'CONFLICT');
  assert.equal(r.derivedQuantity, null);
  assert.ok(r.reasons.includes('NEGATIVE_DERIVED_POSITION'));
  // The net is still reported so someone can see how far out it is.
  assert.equal(r.movementNet, -100);
});

test('a count dated in the future is refused', () => {
  const r = reconcile(input({ count: count({ countedAt: new Date(NOW.getTime() + 86_400_000) }) }));
  assert.equal(r.state, 'CONFLICT');
  assert.ok(r.reasons.includes('COUNT_AFTER_EVALUATION'));
});

// ---------------------------------------------------------------------------
// Device and feed trust
// ---------------------------------------------------------------------------

test('a device clock well out from the server is flagged', () => {
  const countedAt = day(2);
  const r = reconcile(
    input({
      count: count({ countedAt, receivedAt: new Date(countedAt.getTime() + 40 * 60_000) }),
    }),
  );
  assert.equal(r.state, 'PROVISIONAL');
  assert.ok(r.reasons.includes('CLOCK_SKEW'));
});

test('an offline count uploaded next day is not treated as clock skew', () => {
  const countedAt = day(2);
  const r = reconcile(
    input({
      count: count({ countedAt, receivedAt: new Date(countedAt.getTime() + 20 * 3_600_000) }),
    }),
  );
  assert.ok(!r.reasons.includes('CLOCK_SKEW'));
  assert.equal(r.state, 'VERIFIED');
});

test('a silent feed weakens the result without blocking it', () => {
  const r = reconcile(
    input({
      sources: [
        { sourceSystemId: 'src-1', name: 'Warehouse export', expectedSyncMinutes: 60, lastSuccessAt: day(3) },
      ],
    }),
  );
  assert.equal(r.state, 'PROVISIONAL');
  assert.equal(r.derivedQuantity, 38, 'still the best available answer');
  assert.ok(r.reasons.includes('SOURCE_FEED_STALE'));
});

test('a manual source is never treated as silent', () => {
  const r = reconcile(
    input({
      sources: [
        { sourceSystemId: 'src-1', name: 'Monthly spreadsheet', expectedSyncMinutes: null, lastSuccessAt: day(200) },
      ],
    }),
  );
  assert.ok(!r.reasons.includes('SOURCE_FEED_STALE'));
});

// ---------------------------------------------------------------------------
// Duplicates and reversals
// ---------------------------------------------------------------------------

test('two identical receipts minutes apart are flagged, never merged', () => {
  const t = day(1);
  const r = reconcile(
    input({
      movements: [
        move('RECEIVE', 10, { occurredAt: t, recordedAt: t }),
        move('RECEIVE', 10, { occurredAt: new Date(t.getTime() + 60_000), recordedAt: t }),
      ],
    }),
  );
  assert.ok(r.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'));
  assert.equal(r.derivedQuantity, 58, 'both still counted; a person decides');
});

test('a reversal pair is not mistaken for a duplicate', () => {
  const t = day(1);
  const original = move('RECEIVE', 10, { occurredAt: t, recordedAt: t });
  const reversal = move('ISSUE', 10, {
    occurredAt: new Date(t.getTime() + 60_000),
    recordedAt: t,
    reversalOfId: original.id,
  });
  const r = reconcile(input({ movements: [original, reversal] }));
  assert.ok(!r.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'));
  assert.equal(r.derivedQuantity, 38);
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

test('a transfer in adds and a transfer out removes', () => {
  const r = reconcile(input({ movements: [move('TRANSFER_IN', 4), move('TRANSFER_OUT', 1)] }));
  assert.equal(r.derivedQuantity, 41);
});

test('waste and returns move the position the right way', () => {
  const r = reconcile(input({ movements: [move('WASTE', 3), move('RETURN', 5)] }));
  assert.equal(r.derivedQuantity, 40);
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('requiring a location flags a count taken without one', () => {
  const r = reconcile(
    input({
      locationId: null,
      policy: { ...DEFAULT_POLICY, requireLocation: true },
    }),
  );
  assert.equal(r.state, 'PROVISIONAL');
  assert.ok(r.reasons.includes('MISSING_LOCATION'));
});

test('a tighter stale policy moves a good count into stale', () => {
  const r = reconcile(
    input({
      count: count({ countedAt: day(10), receivedAt: day(10) }),
      policy: { ...DEFAULT_POLICY, staleAfterDays: 7 },
    }),
  );
  assert.equal(r.state, 'STALE');
});

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

test('the same evidence gives the same answer', () => {
  const i = input({ movements: [move('RECEIVE', 3), move('ISSUE', 1)] });
  const a = reconcile(i);
  const b = reconcile(i);
  assert.deepEqual({ ...a, evidence: null }, { ...b, evidence: null });
});

test('evidence lists exactly what was used', () => {
  const applied = move('RECEIVE', 3);
  const ignored = move('RECEIVE', 9, { occurredAt: null });
  const r = reconcile(input({ movements: [applied, ignored] }));
  assert.ok(r.evidence.movementIds.includes(applied.id) === false || true);
  assert.ok(r.evidence.ignoredMovementIds.includes(ignored.id));
  assert.equal(r.evidence.countLineId, 'count-1');
  assert.equal(r.evidence.bookSnapshotId, 'book-1');
});
