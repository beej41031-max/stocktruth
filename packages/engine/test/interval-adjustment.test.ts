import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile';
import { explain } from '../src/explain';
import {
  DEFAULT_POLICY,
  type BookSnapshot,
  type CountLine,
  type Movement,
  type ReconciliationInput,
} from '../src/types';
import { checkInvariant } from './invariant';

const NOW = new Date('2026-09-20T18:00:00Z');
const at = (iso: string) => new Date(iso);

const count: CountLine = {
  id: 'report',
  quantity: 100,
  unit: 'each',
  countedAt: at('2026-09-20T06:00:00Z'),
  receivedAt: at('2026-09-20T06:05:00Z'),
  countedBy: '3PL',
  sessionId: 'report',
  sessionWatermark: null,
};

const book = (quantity: number, asOf: Date | null = at('2026-09-20T17:30:00Z')): BookSnapshot => ({
  id: 'level',
  quantity,
  unit: 'each',
  asOf,
  sourceSystemId: 'platform',
});

const issue = (id: string, qty: number, iso: string): Movement => ({
  id,
  type: 'ISSUE',
  quantity: qty,
  unit: 'each',
  occurredAt: at(iso),
  recordedAt: at(iso),
  importedAt: NOW,
  sourceSystemId: 'platform',
  uniqueIdGuaranteed: true,
});

const input = (over: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  item: { id: 'i1', sku: 'A', name: 'A', stockUnit: 'each', active: true, blocked: false },
  locationId: 'L',
  book: book(140),
  count,
  movements: [issue('m1', 10, '2026-09-20T12:00:00Z')],
  unlinkedMovementCount: 0,
  possiblyRelatedUnlinkedCount: 0,
  sources: [],
  policy: { ...DEFAULT_POLICY },
  evaluatedAt: NOW,
  movementFeedComplete: false,
  ...over,
});

test('with no reported change the gap is refused as before', () => {
  const r = reconcile(input());
  assert.equal(r.varianceAtCount, -50);
  assert.ok(r.reasons.includes('BOOK_GAP_UNATTRIBUTABLE'));
  assert.equal(r.derivedQuantity, null);
});

test('a reported change of the right size closes the gap and moves the position, with no movement invented', () => {
  const i = input({ movementFeedComplete: true, intervalAdjustments: [{ id: 'a1', quantity: 50 }] });
  const r = reconcile(i);
  assert.equal(r.varianceAtCount, 0);
  assert.equal(r.derivedQuantity, 140);
  assert.equal(r.movementNet, 40);
  assert.deepEqual(r.evidence.movementIds, ['m1']);
  assert.deepEqual(r.evidence.intervalAdjustmentIds, ['a1']);
  assert.equal(checkInvariant(i), null);
});

test('a change of the wrong size leaves the remainder, in the right direction', () => {
  const short = reconcile(input({ movementFeedComplete: true, intervalAdjustments: [{ id: 'a1', quantity: 30 }] }));
  assert.equal(short.varianceAtCount, -20);
  const wrongWay = reconcile(input({ movementFeedComplete: true, intervalAdjustments: [{ id: 'a1', quantity: -50 }] }));
  assert.equal(wrongWay.varianceAtCount, -100);
  assert.equal(wrongWay.derivedQuantity, 40);
});

test('several reported changes add up', () => {
  const r = reconcile(input({ movementFeedComplete: true, intervalAdjustments: [{ id: 'a1', quantity: 30 }, { id: 'a2', quantity: 20 }] }));
  assert.equal(r.varianceAtCount, 0);
});

test('a reported change cannot collide with a real movement of the same size and type', () => {
  const near = [issue('m1', 14, '2026-09-20T17:28:00Z')];
  const r = reconcile(input({ movements: near, book: book(100 - 14 - 14), movementFeedComplete: true, intervalAdjustments: [{ id: 'a1', quantity: -14 }] }));
  assert.equal(r.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'), false);
  assert.equal(r.varianceAtCount, 0);
  assert.equal(r.derivedQuantity, 72);
});

test('with no interval to belong to, a reported change blocks rather than being placed anywhere', () => {
  const older = input({ book: book(140, at('2026-09-19T12:00:00Z')), intervalAdjustments: [{ id: 'a1', quantity: 5 }] });
  const r = reconcile(older);
  assert.ok(r.reasons.includes('INTERVAL_ADJUSTMENT_UNPLACEABLE'));
  assert.equal(r.derivedQuantity, null);
  assert.equal(checkInvariant(older), null);

  for (const over of [{ book: null }, { book: book(140, null) }]) {
    const x = reconcile(input({ ...over, intervalAdjustments: [{ id: 'a1', quantity: 5 }] }));
    assert.ok(x.reasons.includes('INTERVAL_ADJUSTMENT_UNPLACEABLE'));
    assert.equal(x.derivedQuantity, null);
  }
});

test('a zero or non-finite reported change is refused', () => {
  for (const quantity of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = reconcile(input({ movementFeedComplete: true, intervalAdjustments: [{ id: 'a1', quantity }] }));
    assert.ok(r.reasons.includes('INTERVAL_ADJUSTMENT_UNPLACEABLE'));
    assert.equal(r.derivedQuantity, null);
  }
});

test('the hypothetical position includes a reported change when another blocker remains', () => {
  const adjust: Movement = { ...issue('m2', 3, '2026-09-20T14:00:00Z'), type: 'ADJUST' };
  const i = input({ movements: [issue('m1', 10, '2026-09-20T12:00:00Z'), adjust], movementFeedComplete: true, intervalAdjustments: [{ id: 'a1', quantity: 20 }] });
  const e = explain(i);
  assert.equal(e.refused, true);
  assert.ok(e.blockers.some((b) => b.code === 'ADJUSTMENT_IN_INTERVAL'));
  // the engine's own favourable reading puts the bare adjustment in as +3
  assert.equal(e.ifCleared?.quantity, 100 - 10 + 3 + 20);
  assert.equal(checkInvariant(i), null);
});

test('without the field nothing changes, and no evidence key appears', () => {
  const r = reconcile(input());
  assert.equal('intervalAdjustmentIds' in r.evidence, false);
});
