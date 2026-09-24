import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../src/reconcile';
import { explain } from '../src/explain';
import {
  DEFAULT_POLICY,
  type BookSnapshot,
  type CountLine,
  type Movement,
  type MovementType,
  type ReconciliationInput,
} from '../src/types';
import { checkInvariant } from './invariant';

/**
 * Decision 0025: a book newer than the count, and a movement feed that cannot
 * see every kind of stock change.
 *
 * Both are the normal case for a live commerce platform. The platform's
 * on-hand figure is "now"; the warehouse report was this morning; and the
 * platform's API shows orders and refunds but not manual adjustments.
 */

const NOW = new Date('2026-09-20T18:00:00Z');
const at = (iso: string) => new Date(iso);

const COUNT_AT = at('2026-09-20T06:00:00Z');   // warehouse report, early morning
const BOOK_AT = at('2026-09-20T17:30:00Z');    // platform figure, this evening

const count = (over: Partial<CountLine> = {}): CountLine => ({
  id: 'report-0920',
  quantity: 100,
  unit: 'each',
  countedAt: COUNT_AT,
  receivedAt: at('2026-09-20T06:05:00Z'),
  countedBy: '3PL',
  sessionId: 'report-0920',
  sessionWatermark: null,
  ...over,
});

const book = (quantity: number, over: Partial<BookSnapshot> = {}): BookSnapshot => ({
  id: 'level-1',
  quantity,
  unit: 'each',
  asOf: BOOK_AT,
  sourceSystemId: 'platform',
  ...over,
});

let n = 0;
const move = (type: MovementType, qty: number, iso: string, over: Partial<Movement> = {}): Movement => ({
  id: `mv-${++n}`,
  type,
  quantity: qty,
  unit: 'each',
  occurredAt: at(iso),
  recordedAt: at(iso),
  importedAt: NOW,
  sourceSystemId: 'platform',
  ...over,
});

// A day's trading between the report and the book: 12 shipped, 2 returned.
const TRADING = () => [
  move('ISSUE', 5, '2026-09-20T09:00:00Z'),
  move('ISSUE', 7, '2026-09-20T13:00:00Z'),
  move('RETURN', 2, '2026-09-20T15:00:00Z'),
];

const input = (over: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  item: { id: 'variant-1', sku: 'TEE-BLK-M', name: 'Tee / Black / M', stockUnit: 'each', active: true, blocked: false },
  locationId: 'loc-3pl',
  book: book(90),
  count: count(),
  movements: TRADING(),
  unlinkedMovementCount: 0,
  possiblyRelatedUnlinkedCount: 0,
  sources: [],
  policy: DEFAULT_POLICY,
  evaluatedAt: NOW,
  ...over,
});

test('a book newer than the count is compared after carrying the count forward, not across time', () => {
  // 100 counted, 12 out, 2 back: 90 expected at the book's moment. The book says 90.
  const r = reconcile(input());
  assert.equal(r.varianceAtCount, 0, 'a day of sales must not read as a 10-unit loss');
  assert.equal(r.state, 'VERIFIED');
  assert.equal(r.derivedQuantity, 90);
});

test('with a complete feed, a book that disagrees is simply wrong, and the evidence still stands', () => {
  const r = reconcile(input({ book: book(97) }));
  assert.equal(r.varianceAtCount, -7, 'the book claims 7 more than the evidence supports');
  assert.equal(r.derivedQuantity, 90);
  assert.equal(r.state, 'VERIFIED');
  assert.ok(!r.reasons.includes('BOOK_GAP_UNATTRIBUTABLE'));
});

test('with a partial feed, a disagreement is reported but neither side is called right', () => {
  const r = reconcile(input({ book: book(97), movementFeedComplete: false }));
  assert.equal(r.varianceAtCount, -7, 'the size of the gap is still worth reporting');
  assert.equal(r.derivedQuantity, null, 'an unseen receipt and real loss look identical');
  assert.equal(r.state, 'INCOMPLETE');
  assert.ok(r.reasons.includes('BOOK_GAP_UNATTRIBUTABLE'));
  assert.ok(r.reasons.includes('MOVEMENT_FEED_PARTIAL'));
});

test('with a partial feed, agreement is corroboration but not proof', () => {
  const r = reconcile(input({ movementFeedComplete: false }));
  assert.equal(r.varianceAtCount, 0);
  assert.equal(r.derivedQuantity, 90);
  assert.equal(r.state, 'PROVISIONAL', 'unseen changes netting to zero cannot be ruled out');
  assert.deepEqual(r.reasons, ['MOVEMENT_FEED_PARTIAL']);
});

test('a movement that happened before the book but was recorded after it makes the comparison unsafe', () => {
  const late = move('ISSUE', 3, '2026-09-20T16:00:00Z', { recordedAt: at('2026-09-20T17:45:00Z') });
  const r = reconcile(input({ movements: [...TRADING(), late], book: book(90), movementFeedComplete: false }));
  assert.equal(r.varianceAtCount, null, 'the book may or may not include the late row');
  assert.ok(!r.reasons.includes('BOOK_GAP_UNATTRIBUTABLE'), 'no gap is claimed when none can be measured');
});

test('a bare adjustment between the count and the book withholds the comparison', () => {
  const r = reconcile(input({ movements: [...TRADING(), move('ADJUST', 4, '2026-09-20T11:00:00Z')] }));
  assert.equal(r.varianceAtCount, null);
  assert.ok(r.reasons.includes('ADJUSTMENT_IN_INTERVAL'));
});

test('movements after the book still count towards the current position', () => {
  const evening = move('ISSUE', 4, '2026-09-20T17:50:00Z');
  const r = reconcile(input({ movements: [...TRADING(), evening] }));
  assert.equal(r.varianceAtCount, 0, 'compared at the book moment, before the evening sale');
  assert.equal(r.derivedQuantity, 86, 'current position includes it');
});

test('an older book still works exactly as before', () => {
  const older = book(104, { asOf: at('2026-09-19T12:00:00Z') });
  const r = reconcile(input({ book: older, movements: [move('ISSUE', 4, '2026-09-19T20:00:00Z')] }));
  assert.equal(r.varianceAtCount, 0, '104 then 4 out is 100, which is what was counted');
});

test('the refusal explains itself with the actual numbers', () => {
  const e = explain(input({ book: book(97), movementFeedComplete: false }));
  assert.equal(e.refused, true);
  const text = JSON.stringify(e);
  assert.match(text, /add up to 90 each/);
  assert.match(text, /the system says 97/);
  assert.match(text, /manual adjustment/);
});

test('every case here satisfies the refusal invariant', () => {
  const cases: ReconciliationInput[] = [
    input(),
    input({ book: book(97) }),
    input({ book: book(97), movementFeedComplete: false }),
    input({ movementFeedComplete: false }),
    input({ book: book(80), movementFeedComplete: false }),
    input({ book: null, movementFeedComplete: false }),
  ];
  for (const c of cases) assert.equal(checkInvariant(c), null);
});
