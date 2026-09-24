import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessOperationalPosition } from '../src/operational';
import type { Movement, ReconciliationOutput } from '../src/types';

const output = (over: Partial<ReconciliationOutput> = {}): ReconciliationOutput => ({
  state: 'INCOMPLETE',
  bookQuantity: 19200,
  bookAsOf: new Date('2026-09-01T00:00:00Z'),
  physicalQuantity: 27600,
  physicalCountedAt: new Date('2026-09-15T11:05:00Z'),
  derivedQuantity: null,
  derivedAsOf: null,
  varianceAtCount: null,
  movementNet: 0,
  movementWindowStart: new Date('2026-09-15T11:05:00Z'),
  movementWindowEnd: new Date('2026-09-15T15:00:00Z'),
  reasons: ['MOVEMENT_SPANS_COUNT'],
  evidence: { movementIds: [], ignoredMovementIds: [] },
  ...over,
});

const spanning = (type: Movement['type'], quantity: number, id = 'late-1'): Movement => ({
  id,
  type,
  quantity,
  unit: 'each',
  occurredAt: new Date('2026-09-15T11:00:00Z'),
  recordedAt: new Date('2026-09-15T14:00:00Z'),
  importedAt: new Date('2026-09-15T14:00:00Z'),
  sourceSystemId: 'wms',
});

test('late receipt becomes bounded omitted-stock exposure, not fake exactness', () => {
  const p = assessOperationalPosition({ result: output(), spanningMovements: [spanning('RECEIVE', 8400)] });
  assert.equal(p.exactQuantity, null);
  assert.equal(p.lowerBound, 27600);
  assert.equal(p.upperBound, 36000);
  assert.equal(p.omittedStockExposure, 8400);
  assert.equal(p.phantomStockExposure, 0);
  const allocate = p.advice.find((a) => a.decision === 'ALLOCATE')!;
  assert.equal(allocate.disposition, 'ALLOW');
  assert.equal(allocate.quantityLimit, 27600);
  assert.equal(p.advice.find((a) => a.decision === 'PURCHASE')!.disposition, 'HOLD');
  assert.equal(p.advice.find((a) => a.decision === 'FINANCE')!.disposition, 'BLOCK');
});

test('late issue exposes possible phantom stock in the other direction', () => {
  const p = assessOperationalPosition({ result: output(), spanningMovements: [spanning('ISSUE', 4000)] });
  assert.equal(p.lowerBound, 23600);
  assert.equal(p.upperBound, 27600);
  assert.equal(p.omittedStockExposure, 0);
  assert.equal(p.phantomStockExposure, 4000);
});

test('an unbounded blocker refuses even a range', () => {
  const p = assessOperationalPosition({
    result: output({ reasons: ['MOVEMENT_UNDATED'] }),
    spanningMovements: [spanning('RECEIVE', 8400)],
    hasUnboundedBlocker: true,
  });
  assert.equal(p.lowerBound, null);
  assert.ok(p.advice.every((a) => a.disposition === 'BLOCK'));
});

test('an exact verified result stays exact and is usable for finance', () => {
  const p = assessOperationalPosition({
    result: output({ state: 'VERIFIED', derivedQuantity: 28000, movementNet: 400, reasons: [] }),
  });
  assert.equal(p.exactQuantity, 28000);
  assert.equal(p.lowerBound, 28000);
  assert.equal(p.upperBound, 28000);
  assert.equal(p.advice.find((a) => a.decision === 'FINANCE')!.disposition, 'ALLOW');
});


test('opposite-sign spanning movements widen the range instead of cancelling to fake exactness', () => {
  const p = assessOperationalPosition({
    result: output(),
    spanningMovements: [
      spanning('RECEIVE', 500, 'receipt-500'),
      spanning('TRANSFER_OUT', 500, 'transfer-500'),
    ],
  });
  assert.equal(p.exactQuantity, null);
  assert.equal(p.lowerBound, 27100);
  assert.equal(p.upperBound, 28100);
  assert.equal(p.omittedStockExposure, 500);
  assert.equal(p.phantomStockExposure, 500);
  assert.equal(p.advice.find((a) => a.decision === 'ALLOCATE')!.quantityLimit, 27100);
});

test('a complete reversal pair is removed from spanning exposure', () => {
  const original = spanning('RECEIVE', 500, 'original');
  const reversal = { ...spanning('ISSUE', 500, 'reversal'), reversalOfId: 'original' };
  const p = assessOperationalPosition({ result: output(), spanningMovements: [original, reversal] });
  assert.equal(p.lowerBound, null, 'no unresolved spanning movement remains, so this layer does not invent a range');
});


test('negative mathematical floor is clamped to zero and never becomes negative allocation advice', () => {
  const p = assessOperationalPosition({
    result: output({ physicalQuantity: 100, bookQuantity: 100 }),
    spanningMovements: [spanning('TRANSFER_OUT', 500, 'big-transfer')],
  });
  assert.equal(p.lowerBound, 0);
  assert.equal(p.upperBound, 100);
  assert.equal(p.advice.find((a) => a.decision === 'ALLOCATE')!.quantityLimit, 0);
});

test('a spanning movement with a negative quantity cannot become a bounded range', () => {
  const p = assessOperationalPosition({
    result: output(),
    spanningMovements: [spanning('RECEIVE', -5, 'bad-negative-receipt')],
  });
  assert.equal(p.lowerBound, null);
  assert.equal(p.upperBound, null);
  assert.ok(p.advice.every((a) => a.disposition === 'BLOCK'));
});

test('a spanning ADJUST cannot be assigned a direction by the operational layer', () => {
  const p = assessOperationalPosition({
    result: output(),
    spanningMovements: [spanning('ADJUST', 3, 'ambiguous-adjustment')],
  });
  assert.equal(p.lowerBound, null);
  assert.equal(p.upperBound, null);
  assert.ok(p.advice.every((a) => a.disposition === 'BLOCK'));
});

test('suspected duplicate evidence can never be laundered into an operational range', () => {
  const p = assessOperationalPosition({
    result: output({
      state: 'INCOMPLETE',
      derivedQuantity: null,
      movementNet: 100,
      reasons: ['SUSPECTED_DUPLICATE_MOVEMENT'],
    }),
    spanningMovements: [spanning('RECEIVE', 500, 'unrelated-span')],
  });

  assert.equal(p.exactQuantity, null);
  assert.equal(p.lowerBound, null);
  assert.equal(p.upperBound, null);
  assert.ok(p.advice.every((advice) => advice.disposition === 'BLOCK'));
});
