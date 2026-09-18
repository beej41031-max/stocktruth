import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explain } from '../src/explain';
import { reconcile } from '../src/reconcile';
import { REASONS, type ReasonDefinition } from '../src/reasons';
import {
  DEFAULT_POLICY,
  type Movement,
  type MovementType,
  type ReconciliationInput,
} from '../src/types';

/**
 * The canonical case.
 *
 * Book says 19,200 as at 22 August. Somebody counted 27,600 on 14 September at
 * 12:02. A pallet of 8,400 cans physically arrived at 11:02 that morning and
 * was keyed in at 15:02, three hours after the count.
 *
 * Every temporal trap this product exists for is in that one item, which is why
 * it is a fixture rather than an anecdote in a readme. If these tests ever go
 * green while the engine states a number, the product has stopped being the
 * thing it was built to be.
 */

const COUNTED_AT = new Date('2026-09-14T12:02:00Z');
const ARRIVED_AT = new Date('2026-09-14T11:02:00Z');
const KEYED_AT = new Date('2026-09-14T15:02:00Z');
const NOW = new Date('2026-09-17T09:00:00Z');

const move = (type: MovementType, qty: number, over: Partial<Movement> = {}): Movement => ({
  id: 'mv-pallet',
  type,
  quantity: qty,
  unit: 'each',
  occurredAt: ARRIVED_AT,
  recordedAt: KEYED_AT,
  importedAt: KEYED_AT,
  sourceSystemId: 'src-warehouse',
  ...over,
});

function canPallet(over: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    item: {
      id: 'item-can-440',
      sku: 'PKG-CAN-440',
      name: 'Can 440ml unprinted',
      stockUnit: 'each',
      active: true,
      blocked: false,
    },
    locationId: 'loc-pack',
    book: {
      id: 'book-1',
      quantity: 19_200,
      unit: 'each',
      asOf: new Date('2026-08-22T00:00:00Z'),
      sourceSystemId: 'src-sheet',
    },
    count: {
      id: 'count-1',
      quantity: 27_600,
      unit: 'each',
      countedAt: COUNTED_AT,
      receivedAt: COUNTED_AT,
      countedBy: 'user-rana',
      sessionId: 'sess-1',
      sessionWatermark: new Date('2026-09-14T11:42:00Z'),
    },
    movements: [move('RECEIVE', 8_400)],
    unlinkedMovementCount: 0,
    possiblyRelatedUnlinkedCount: 0,
    sources: [],
    policy: DEFAULT_POLICY,
    evaluatedAt: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------

test('the pallet case refuses a position', () => {
  const r = reconcile(canPallet());
  assert.equal(r.state, 'INCOMPLETE');
  assert.equal(r.derivedQuantity, null);
  assert.ok(r.reasons.includes('MOVEMENT_SPANS_COUNT'));
  // What was counted is still known and still reported.
  assert.equal(r.physicalQuantity, 27_600);
  assert.equal(r.bookQuantity, 19_200);
});

test('no discrepancy is claimed between a 22 August book and a 14 September count', () => {
  const r = reconcile(canPallet());
  assert.equal(
    r.varianceAtCount,
    null,
    'the movement record in between is not complete enough for the subtraction to mean anything',
  );
});

test('the refusal names exactly what is blocking it', () => {
  const e = explain(canPallet());
  assert.equal(e.refused, true);
  assert.deepEqual(
    e.blockers.map((b) => b.code),
    ['MOVEMENT_SPANS_COUNT'],
  );
  // The evidence is specific enough to check by hand against the database.
  assert.match(e.blockers[0]!.evidence[0]!, /mv-pallet/);
  assert.match(e.blockers[0]!.evidence[0]!, /8400|8,400/);
});

test('the refusal says what evidence would clear it', () => {
  const e = explain(canPallet());
  assert.match(e.blockers[0]!.remedy, /ruling|present at the count/i);
});

test('and what the number would be if it were cleared, with the assumption attached', () => {
  const e = explain(canPallet());
  // If those cans were on the shelf when counted, the count already includes
  // them and nothing moved afterwards, so 27,600 stands.
  assert.equal(e.ifCleared?.quantity, 27_600);
  assert.ok(e.ifCleared!.assuming.some((a) => /already on the shelf/i.test(a)));
});

// ---------------------------------------------------------------------------
// The definition of a refusal, checked both ways round
// ---------------------------------------------------------------------------

test('clearing every blocker makes the number appear', () => {
  // Same evidence, except the paperwork went in before the counter arrived.
  const cleared = canPallet({
    movements: [move('RECEIVE', 8_400, { recordedAt: new Date('2026-09-14T11:10:00Z') })],
  });
  const e = explain(cleared);
  assert.equal(e.refused, false);
  assert.deepEqual(e.blockers, []);
  assert.equal(e.derivedQuantity, 27_600);
});

test('a refusal without a blocking reason is a bug, and explain throws rather than hiding it', () => {
  // The invariant: derivedQuantity === null if and only if a blocking reason is
  // present. explain() asserts it on every call, so a rule change that breaks
  // the relationship fails loudly here rather than quietly in production.
  const cases: ReconciliationInput[] = [
    canPallet(),
    canPallet({ count: null }),
    canPallet({ movements: [] }),
    canPallet({ item: { ...canPallet().item, blocked: true } }),
    canPallet({ possiblyRelatedUnlinkedCount: 2 }),
    canPallet({ movements: [move('RECEIVE', 8_400, { occurredAt: null })] }),
    canPallet({ movements: [move('ISSUE', 90_000, { occurredAt: NOW, recordedAt: NOW })] }),
    canPallet({ book: { ...canPallet().book!, unit: 'case' } }),
  ];
  for (const input of cases) {
    assert.doesNotThrow(() => explain(input));
  }
});

test('every reason declares whether it blocks and what would clear it', () => {
  for (const [code, def] of Object.entries(REASONS as Record<string, ReasonDefinition>)) {
    assert.equal(typeof def.blocks, 'boolean', `${code} does not say whether it blocks`);
    assert.ok(def.remedy.length > 10, `${code} does not say what would clear it`);
    assert.ok(def.action.length > 10, `${code} does not say what to do about it`);
  }
});

test('blocking reasons are the only ones that withhold a number', () => {
  // Assemble every caveat-only reason we can produce at once and confirm the
  // engine still commits to a figure. If a non-blocking reason ever starts
  // withholding one, this fails.
  const caveated = canPallet({
    movements: [move('RECEIVE', 8_400, { recordedAt: new Date('2026-09-14T11:10:00Z') })],
    unlinkedMovementCount: 4,
    locationId: null,
    sources: [
      {
        sourceSystemId: 'src-warehouse',
        name: 'Warehouse export',
        expectedSyncMinutes: 60,
        lastSuccessAt: new Date('2026-09-13T09:00:00Z'),
      },
    ],
  });
  const e = explain(caveated);
  assert.equal(e.refused, false);
  assert.ok(e.caveats.length >= 2);
  assert.equal(e.derivedQuantity, 27_600);
});

// ---------------------------------------------------------------------------
// Precision
// ---------------------------------------------------------------------------

test('ordering is decided on full precision, not on what a screen displays', () => {
  // Both render as 12:02. They are forty seconds apart and the order matters.
  const countedAt = new Date('2026-09-14T12:02:50Z');
  const r = reconcile(
    canPallet({
      count: { ...canPallet().count!, countedAt, receivedAt: countedAt },
      movements: [
        move('RECEIVE', 100, {
          occurredAt: new Date('2026-09-14T12:02:10Z'),
          recordedAt: new Date('2026-09-14T12:02:10Z'),
        }),
      ],
    }),
  );
  // It happened before the count and was recorded before it, so it is already
  // inside the counted figure and must not be added again.
  assert.equal(r.derivedQuantity, 27_600);
});

test('a movement forty seconds after the count is applied', () => {
  const countedAt = new Date('2026-09-14T12:02:10Z');
  const r = reconcile(
    canPallet({
      count: { ...canPallet().count!, countedAt, receivedAt: countedAt },
      movements: [
        move('RECEIVE', 100, {
          occurredAt: new Date('2026-09-14T12:02:50Z'),
          recordedAt: new Date('2026-09-14T12:02:50Z'),
        }),
      ],
    }),
  );
  assert.equal(r.derivedQuantity, 27_700);
});
