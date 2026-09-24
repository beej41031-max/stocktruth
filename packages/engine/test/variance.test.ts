import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyseMaterialVariance, compareVerificationCandidates, scoreVerificationCandidate } from '../src/variance';
import type { BomVersion, MaterialVarianceInput, ProductionOutput } from '../src/variance';
import type { Movement, MovementType } from '../src/types';

const openingAt = new Date('2026-09-01T07:00:00Z');
const closingAt = new Date('2026-09-15T07:00:00Z');

const movement = (type: MovementType, quantity: number, over: Partial<Movement> = {}): Movement => ({
  id: `${type}-${quantity}-${Math.random()}`,
  type,
  quantity,
  unit: 'kg',
  occurredAt: new Date('2026-09-07T12:00:00Z'),
  recordedAt: new Date('2026-09-07T12:05:00Z'),
  importedAt: new Date('2026-09-07T12:06:00Z'),
  sourceSystemId: 'warehouse',
  ...over,
});

const production: ProductionOutput[] = [
  { id: 'run-1', productId: 'widget', quantity: 1000, unit: 'each', completedAt: new Date('2026-09-08T18:00:00Z'), recordedAt: new Date('2026-09-08T18:05:00Z'), importedAt: new Date('2026-09-08T18:06:00Z'), sourceSystemId: 'production' },
];

const boms: BomVersion[] = [
  {
    id: 'bom-1',
    productId: 'widget',
    outputUnit: 'each',
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    lines: [{ itemId: 'resin', quantityPerOutput: 9.74, unit: 'kg' }],
  },
];

const input = (over: Partial<MaterialVarianceInput> = {}): MaterialVarianceInput => ({
  itemId: 'resin',
  unit: 'kg',
  opening: { id: 'count-1', quantity: 8420, unit: 'kg', countedAt: openingAt },
  closing: { id: 'count-2', quantity: 4910, unit: 'kg', countedAt: closingAt },
  movements: [movement('RECEIVE', 6800)],
  production,
  boms,
  movementWatermark: new Date('2026-09-15T09:00:00Z'),
  movementWatermarkObservedAt: new Date('2026-09-15T09:05:00Z'),
  productionWatermark: new Date('2026-09-15T09:00:00Z'),
  productionWatermarkObservedAt: new Date('2026-09-15T09:05:00Z'),
  unitCost: 4.3,
  ...over,
});

test('two counts plus receipts reveal actual consumption', () => {
  const out = analyseMaterialVariance(input());
  assert.equal(out.state, 'CLOSED');
  assert.equal(out.actualConsumption, 10310);
  assert.equal(out.theoreticalConsumption, 9740);
  assert.equal(out.varianceQuantity, 570);
  assert.ok(Math.abs((out.varianceCost ?? 0) - 2451) < 0.0001);
  assert.ok(Math.abs((out.variancePercent ?? 0) - 5.85215605749) < 0.0001);
});

test('transfers are separated from production consumption', () => {
  const out = analyseMaterialVariance(
    input({ movements: [movement('RECEIVE', 6800), movement('TRANSFER_OUT', 300)] }),
  );
  assert.equal(out.actualConsumption, 10010);
  assert.equal(out.transferOut, 300);
});

test('recorded production issues do not get subtracted twice', () => {
  const out = analyseMaterialVariance(
    input({ movements: [movement('RECEIVE', 6800), movement('ISSUE', 4000), movement('WASTE', 200)] }),
  );
  assert.equal(out.actualConsumption, 10310);
  assert.equal(out.recordedConsumption, 4200);
});

test('a late-recorded receipt belongs to event time and is surfaced', () => {
  const out = analyseMaterialVariance(
    input({
      movements: [
        movement('RECEIVE', 6800, {
          occurredAt: new Date('2026-09-14T10:00:00Z'),
          recordedAt: new Date('2026-09-16T08:00:00Z'),
          importedAt: new Date('2026-09-16T08:00:00Z'),
        }),
      ],
    }),
  );
  assert.equal(out.actualConsumption, 10310);
  assert.equal(out.lateRecordedMovementCount, 1);
  assert.ok(out.reasons.includes('LATE_RECORDED_MOVEMENT'));
  assert.equal(out.state, 'PROVISIONAL', 'evidence arriving after the closure claim reopens the interval');
});

test('without a watermark the interval stays provisional', () => {
  const out = analyseMaterialVariance(input({ movementWatermark: null }));
  assert.equal(out.state, 'PROVISIONAL');
  assert.equal(out.varianceQuantity, 570, 'show the arithmetic without pretending the interval is closed');
  assert.ok(out.reasons.includes('SOURCE_NOT_SETTLED_THROUGH_CLOSE'));
});

test('undated movement blocks actual consumption', () => {
  const out = analyseMaterialVariance(
    input({ movements: [movement('RECEIVE', 100, { occurredAt: null })] }),
  );
  assert.equal(out.state, 'INCOMPLETE');
  assert.equal(out.actualConsumption, null);
});

test('manual adjustment blocks the interval because physical meaning is ambiguous', () => {
  const out = analyseMaterialVariance(input({ movements: [movement('ADJUST', 100)] }));
  assert.equal(out.state, 'INCOMPLETE');
  assert.ok(out.reasons.includes('ADJUSTMENT_IN_INTERVAL'));
});

test('missing BOM preserves actual use but refuses to invent theoretical use', () => {
  const out = analyseMaterialVariance(input({ boms: [] }));
  assert.equal(out.state, 'ACTUAL_ONLY');
  assert.equal(out.actualConsumption, 10310);
  assert.equal(out.theoreticalConsumption, null);
  assert.equal(out.varianceQuantity, null);
  assert.ok(out.reasons.includes('MISSING_BOM'));
});

test('effective BOM version is selected at production completion time', () => {
  const oldBom: BomVersion = {
    id: 'old', productId: 'widget', outputUnit: 'each', validFrom: new Date('2026-01-01'), validTo: new Date('2026-09-05'),
    lines: [{ itemId: 'resin', quantityPerOutput: 8, unit: 'kg' }],
  };
  const newBom: BomVersion = {
    id: 'new', productId: 'widget', outputUnit: 'each', validFrom: new Date('2026-09-05'), validTo: null,
    lines: [{ itemId: 'resin', quantityPerOutput: 9.74, unit: 'kg' }],
  };
  const out = analyseMaterialVariance(input({ boms: [oldBom, newBom] }));
  assert.equal(out.theoreticalConsumption, 9740);
  assert.deepEqual(out.bomVersionIds, ['new']);
});

test('overlapping BOM versions are refused rather than averaged', () => {
  const out = analyseMaterialVariance(input({ boms: [boms[0]!, { ...boms[0]!, id: 'bom-2' }] }));
  assert.equal(out.theoreticalConsumption, null);
  assert.ok(out.reasons.includes('AMBIGUOUS_BOM'));
});

test('negative residual consumption is a conflict', () => {
  const out = analyseMaterialVariance(
    input({
      opening: { id: 'c1', quantity: 100, unit: 'kg', countedAt: openingAt },
      closing: { id: 'c2', quantity: 500, unit: 'kg', countedAt: closingAt },
      movements: [],
      production: [],
      boms: [],
    }),
  );
  assert.equal(out.state, 'CONFLICT');
  assert.equal(out.actualConsumption, -400);
  assert.ok(out.reasons.includes('NEGATIVE_ACTUAL_CONSUMPTION'));
});

test('verification queue ranks economic exposure and overdue cadence transparently', () => {
  const candidate = scoreVerificationCandidate({
    itemId: 'resin',
    unitCost: 4,
    uncertaintyQuantity: 100,
    historicalVarianceCost: 1200,
    unsettledVarianceCost: 900,
    daysSinceCount: 14,
    targetCycleDays: 7,
  });
  assert.equal(candidate.economicExposure, 1200);
  assert.equal(candidate.overdueRatio, 2);
  assert.equal(candidate.priorityScore, 2400);
  assert.match(candidate.why, /historical material variance/);
});


test('a movement and its linked reversal are removed before variance arithmetic', () => {
  const original = movement('RECEIVE', 200, { id: 'receipt-200' });
  const reversal = movement('ISSUE', 200, { id: 'reverse-200', reversalOfId: 'receipt-200' });
  const out = analyseMaterialVariance(
    input({
      opening: { id: 'c1', quantity: 1000, unit: 'kg', countedAt: openingAt },
      closing: { id: 'c2', quantity: 600, unit: 'kg', countedAt: closingAt },
      movements: [original, reversal],
      production: [{ ...production[0]!, quantity: 40 }],
      boms: [{ ...boms[0]!, lines: [{ itemId: 'resin', quantityPerOutput: 10, unit: 'kg' }] }],
    }),
  );
  assert.equal(out.state, 'CLOSED');
  assert.equal(out.receipts, 0);
  assert.equal(out.actualConsumption, 400);
  assert.equal(out.theoreticalConsumption, 400);
  assert.equal(out.varianceQuantity, 0);
  assert.deepEqual(new Set(out.evidence.ignoredReversalMovementIds), new Set(['receipt-200', 'reverse-200']));
});

test('missing production completeness never turns physical use into a closed false loss', () => {
  const out = analyseMaterialVariance(
    input({
      opening: { id: 'c1', quantity: 1000, unit: 'kg', countedAt: openingAt },
      closing: { id: 'c2', quantity: 600, unit: 'kg', countedAt: closingAt },
      movements: [],
      production: [],
      boms: [],
      productionWatermark: null,
      unitCost: 1,
    }),
  );
  assert.equal(out.actualConsumption, 400);
  assert.equal(out.state, 'ACTUAL_ONLY');
  assert.equal(out.theoreticalConsumption, null);
  assert.equal(out.varianceQuantity, null);
  assert.equal(out.varianceCost, null);
  assert.ok(out.reasons.includes('PRODUCTION_NOT_SETTLED_THROUGH_CLOSE'));
});

test('an explicitly settled zero-production interval may close at zero theory', () => {
  const out = analyseMaterialVariance(
    input({
      opening: { id: 'c1', quantity: 1000, unit: 'kg', countedAt: openingAt },
      closing: { id: 'c2', quantity: 600, unit: 'kg', countedAt: closingAt },
      movements: [],
      production: [],
      boms: [],
      productionWatermark: new Date('2026-09-15T09:00:00Z'),
      unitCost: 1,
    }),
  );
  assert.equal(out.state, 'CLOSED');
  assert.equal(out.theoreticalConsumption, 0);
  assert.equal(out.varianceQuantity, 400);
  assert.equal(out.varianceCost, 400);
});

test('production output unit mismatch refuses theory instead of scaling silently', () => {
  const out = analyseMaterialVariance(
    input({ production: [{ ...production[0]!, unit: 'case' }] }),
  );
  assert.equal(out.state, 'ACTUAL_ONLY');
  assert.equal(out.theoreticalConsumption, null);
  assert.equal(out.varianceQuantity, null);
  assert.ok(out.reasons.includes('OUTPUT_UNIT_MISMATCH'));
});

test('site-wide production theory is not allocated to an ambiguous location scope', () => {
  const out = analyseMaterialVariance(input({ theoryScopeComplete: false }));
  assert.equal(out.state, 'ACTUAL_ONLY');
  assert.equal(out.actualConsumption, 10310);
  assert.equal(out.theoreticalConsumption, null);
  assert.equal(out.varianceQuantity, null);
  assert.ok(out.reasons.includes('THEORY_SCOPE_AMBIGUOUS'));
});

test('production keyed after the count but before a later closure assertion can still close', () => {
  const out = analyseMaterialVariance(input({
    production: [{ ...production[0]!, recordedAt: new Date('2026-09-15T08:30:00Z') }],
    productionWatermarkObservedAt: new Date('2026-09-15T09:05:00Z'),
  }));
  assert.equal(out.state, 'CLOSED');
  assert.equal(out.lateRecordedProductionCount, 0);
});


test('import time becomes knowledge time when recorded_at is absent', () => {
  const lateMovement = movement('RECEIVE', 6800, {
    recordedAt: null,
    importedAt: new Date('2026-09-16T08:00:00Z'),
  });
  const lateOutput = {
    ...production[0]!,
    recordedAt: null,
    importedAt: new Date('2026-09-16T09:00:00Z'),
  };
  const out = analyseMaterialVariance(input({ movements: [lateMovement], production: [lateOutput] }));
  assert.equal(out.lateRecordedMovementCount, 1);
  assert.equal(out.lateRecordedProductionCount, 1);
  assert.ok(out.reasons.includes('LATE_RECORDED_MOVEMENT'));
  assert.ok(out.reasons.includes('LATE_RECORDED_PRODUCTION'));
});

test('an orphan reversal refuses interval arithmetic instead of silently dropping a correction', () => {
  const orphan = movement('ISSUE', 200, { id: 'orphan-reversal', reversalOfId: 'missing-original' });
  const out = analyseMaterialVariance(input({ movements: [orphan] }));
  assert.equal(out.state, 'INCOMPLETE');
  assert.equal(out.actualConsumption, null);
  assert.ok(out.reasons.includes('ORPHAN_REVERSAL'));
});

test('reversing a reversal reinstates the original receipt', () => {
  const original = movement('RECEIVE', 200, { id: 'receipt-200' });
  const reversal = movement('ISSUE', 200, { id: 'reverse-200', reversalOfId: 'receipt-200' });
  const reinstate = movement('RECEIVE', 200, { id: 'reinstate-200', reversalOfId: 'reverse-200' });
  const out = analyseMaterialVariance(
    input({
      opening: { id: 'c1', quantity: 1000, unit: 'kg', countedAt: openingAt },
      closing: { id: 'c2', quantity: 800, unit: 'kg', countedAt: closingAt },
      movements: [original, reversal, reinstate],
      production: [{ ...production[0]!, quantity: 40 }],
      boms: [{ ...boms[0]!, lines: [{ itemId: 'resin', quantityPerOutput: 10, unit: 'kg' }] }],
    }),
  );
  assert.equal(out.state, 'CLOSED');
  assert.equal(out.receipts, 200);
  assert.equal(out.actualConsumption, 400);
  assert.equal(out.varianceQuantity, 0);
  assert.deepEqual(new Set(out.evidence.ignoredReversalMovementIds), new Set(['reverse-200', 'reinstate-200']));
});

test('two reversals against one original are ledger ambiguity, not a silent cancellation', () => {
  const original = movement('RECEIVE', 200, { id: 'receipt-200' });
  const r1 = movement('ISSUE', 200, { id: 'reverse-a', reversalOfId: 'receipt-200' });
  const r2 = movement('ISSUE', 200, { id: 'reverse-b', reversalOfId: 'receipt-200' });
  const out = analyseMaterialVariance(input({ movements: [original, r1, r2] }));
  assert.equal(out.state, 'INCOMPLETE');
  assert.ok(out.reasons.includes('INVALID_REVERSAL_PAIR'));
});

test('paperwork entered after the count but before a later manual closure assertion is not late evidence', () => {
  const receipt = movement('RECEIVE', 6800, {
    occurredAt: new Date('2026-09-14T10:00:00Z'),
    recordedAt: new Date('2026-09-15T11:00:00Z'),
  });
  const out = analyseMaterialVariance(input({
    movements: [receipt],
    movementWatermarkObservedAt: new Date('2026-09-15T14:00:00Z'),
  }));
  assert.equal(out.state, 'CLOSED');
  assert.equal(out.lateRecordedMovementCount, 0);
});

test('production evidence arriving after its closure assertion reopens theory', () => {
  const out = analyseMaterialVariance(input({
    production: [{ ...production[0]!, recordedAt: new Date('2026-09-16T09:00:00Z'), importedAt: new Date('2026-09-16T09:00:00Z') }],
    productionWatermarkObservedAt: new Date('2026-09-15T09:05:00Z'),
  }));
  assert.equal(out.state, 'ACTUAL_ONLY');
  assert.equal(out.theoreticalConsumption, null);
  assert.equal(out.varianceCost, null);
  assert.ok(out.reasons.includes('LATE_RECORDED_PRODUCTION'));
});

test('interval boundary is explicitly (opening, closing]', () => {
  const atOpen = movement('RECEIVE', 100, { id: 'at-open', occurredAt: openingAt });
  const atClose = movement('RECEIVE', 200, { id: 'at-close', occurredAt: closingAt });
  const out = analyseMaterialVariance(input({ movements: [atOpen, atClose] }));
  assert.equal(out.receipts, 200);
  assert.ok(!out.evidence.movementIds.includes('at-open'));
  assert.ok(out.evidence.movementIds.includes('at-close'));
});

test('verification queue still prioritises an uncosted item using quantity and cadence', () => {
  const candidate = scoreVerificationCandidate({
    itemId: 'uncosted',
    unitCost: null,
    uncertaintyQuantity: null,
    historicalVarianceCost: 0,
    historicalVarianceQuantity: 250,
    unsettledVarianceCost: 0,
    daysSinceCount: 20,
    targetCycleDays: 7,
  });
  assert.ok(candidate.priorityScore > 0);
  assert.equal(candidate.priorityBasis, 'QUANTITY');
  assert.equal(candidate.economicExposure, null);
});


test('verification ranking never compares unpriced units directly with priced exposure', () => {
  const cans = scoreVerificationCandidate({
    itemId: 'cans', unitCost: 1, uncertaintyQuantity: 400,
    historicalVarianceCost: 0, unsettledVarianceCost: 0,
    daysSinceCount: 7, targetCycleDays: 7,
  });
  const washers = scoreVerificationCandidate({
    itemId: 'washers', unitCost: null, uncertaintyQuantity: 5000,
    historicalVarianceCost: 0, historicalVarianceQuantity: 5000,
    unsettledVarianceCost: 0, daysSinceCount: 7, targetCycleDays: 7,
  });
  const ranked = [washers, cans].sort(compareVerificationCandidates);
  assert.equal(ranked[0]!.itemId, 'cans');
  assert.equal(ranked[1]!.itemId, 'washers');
});

test('a later manual attestation cannot hide evidence that arrived after an automated source claimed completeness', () => {
  const receipt = movement('RECEIVE', 6800, {
    sourceSystemId: 'warehouse-auto',
    recordedAt: new Date('2026-09-15T12:00:00Z'),
    importedAt: new Date('2026-09-15T12:00:00Z'),
  });
  const out = analyseMaterialVariance(input({
    movements: [receipt],
    movementWatermarkObservedAt: new Date('2026-09-15T14:00:00Z'),
    movementKnowledgePolicy: {
      automatedClaimedAtBySource: {
        'warehouse-auto': new Date('2026-09-15T10:00:00Z'),
      },
      manualClaimedAt: new Date('2026-09-15T14:00:00Z'),
    },
  }));
  assert.equal(out.state, 'PROVISIONAL');
  assert.equal(out.lateRecordedMovementCount, 1);
  assert.ok(out.reasons.includes('LATE_RECORDED_MOVEMENT'));
});

test('manual paperwork keyed before its later office attestation is not made late by an earlier automated claim', () => {
  const receipt = movement('RECEIVE', 6800, {
    sourceSystemId: null,
    recordedAt: new Date('2026-09-15T12:00:00Z'),
    importedAt: new Date('2026-09-15T12:00:00Z'),
  });
  const out = analyseMaterialVariance(input({
    movements: [receipt],
    movementWatermarkObservedAt: new Date('2026-09-15T14:00:00Z'),
    movementKnowledgePolicy: {
      automatedClaimedAtBySource: {
        'warehouse-auto': new Date('2026-09-15T10:00:00Z'),
      },
      manualClaimedAt: new Date('2026-09-15T14:00:00Z'),
    },
  }));
  assert.equal(out.state, 'CLOSED');
  assert.equal(out.lateRecordedMovementCount, 0);
});


test('backdated source timestamps do not hide evidence imported after a closure claim', () => {
  const receipt = movement('RECEIVE', 200, {
    id: 'backdated-import',
    occurredAt: new Date('2026-09-07T08:00:00Z'),
    recordedAt: new Date('2026-09-07T09:00:00Z'),
    importedAt: new Date('2026-09-10T09:00:00Z'),
    sourceSystemId: 'warehouse-auto',
  });
  const out = analyseMaterialVariance(input({
    movements: [receipt],
    movementWatermark: new Date('2026-09-15T08:00:00Z'),
    movementWatermarkObservedAt: new Date('2026-09-09T09:00:00Z'),
    movementKnowledgePolicy: {
      automatedClaimedAtBySource: { 'warehouse-auto': new Date('2026-09-09T09:00:00Z') },
      manualClaimedAt: null,
    },
  }));
  assert.equal(out.state, 'PROVISIONAL');
  assert.equal(out.lateRecordedMovementCount, 1);
  assert.ok(out.reasons.includes('LATE_RECORDED_MOVEMENT'));
});

test('a reversal inside the interval can cancel an original before the opening count', () => {
  const original = movement('RECEIVE', 200, {
    id: 'pre-open-receipt',
    occurredAt: new Date('2026-08-31T10:00:00Z'),
    recordedAt: new Date('2026-08-31T10:05:00Z'),
    importedAt: new Date('2026-08-31T10:06:00Z'),
  });
  const reversal = movement('ISSUE', 200, {
    id: 'in-window-reversal',
    occurredAt: new Date('2026-09-07T10:00:00Z'),
    recordedAt: new Date('2026-09-07T10:05:00Z'),
    importedAt: new Date('2026-09-07T10:06:00Z'),
    reversalOfId: 'pre-open-receipt',
  });
  const out = analyseMaterialVariance(input({ movements: [original, reversal] }));
  assert.equal(out.receipts, 0);
  assert.equal(out.recordedConsumption, 0);
  assert.ok(out.evidence.ignoredReversalMovementIds.includes('pre-open-receipt'));
  assert.ok(out.evidence.ignoredReversalMovementIds.includes('in-window-reversal'));
});


test('backdated production timestamps cannot hide output imported after a closure claim', () => {
  const lateOutput = {
    ...production[0]!,
    recordedAt: new Date('2026-09-08T18:05:00Z'),
    importedAt: new Date('2026-09-16T09:00:00Z'),
  };
  const out = analyseMaterialVariance(input({
    production: [lateOutput],
    productionWatermarkObservedAt: new Date('2026-09-15T09:05:00Z'),
    productionKnowledgePolicy: {
      automatedClaimedAtBySource: { production: new Date('2026-09-15T09:05:00Z') },
      manualClaimedAt: null,
    },
  }));
  assert.equal(out.state, 'ACTUAL_ONLY');
  assert.equal(out.lateRecordedProductionCount, 1);
  assert.ok(out.reasons.includes('LATE_RECORDED_PRODUCTION'));
});

test('promptly uploaded count with clock skew refuses the material interval', () => {
  const out = analyseMaterialVariance(input({
    closing: {
      id: 'count-2',
      quantity: 4910,
      unit: 'kg',
      countedAt: closingAt,
      receivedAt: new Date(closingAt.getTime() + 35 * 60_000),
    },
    maxClockSkewMinutes: 10,
  }));
  assert.equal(out.state, 'CONFLICT');
  assert.ok(out.reasons.includes('COUNT_CLOCK_SKEW'));
  assert.equal(out.actualConsumption, null);
});

test('genuinely offline count is not rejected as clock skew', () => {
  const out = analyseMaterialVariance(input({
    closing: {
      id: 'count-2',
      quantity: 4910,
      unit: 'kg',
      countedAt: closingAt,
      receivedAt: new Date(closingAt.getTime() + 8 * 60 * 60_000),
    },
    maxClockSkewMinutes: 10,
  }));
  assert.equal(out.state, 'CLOSED');
  assert.ok(!out.reasons.includes('COUNT_CLOCK_SKEW'));
});

test('reviewed late automated movement can re-close, and a later arrival reopens it again', () => {
  const reviewedReceipt = movement('RECEIVE', 200, {
    id: 'reviewed-late',
    occurredAt: new Date('2026-09-07T08:00:00Z'),
    recordedAt: new Date('2026-09-07T09:00:00Z'),
    importedAt: new Date('2026-09-10T09:00:00Z'),
    sourceSystemId: 'nory',
  });
  const closed = analyseMaterialVariance(input({
    movements: [reviewedReceipt],
    movementWatermarkObservedAt: new Date('2026-09-11T09:00:00Z'),
    movementKnowledgePolicy: {
      automatedClaimedAtBySource: { nory: new Date('2026-09-10T09:00:00Z') },
      manualClaimedAt: null,
    },
  }));
  assert.equal(closed.state, 'CLOSED');
  assert.equal(closed.lateRecordedMovementCount, 0);

  const laterCorrection = movement('RECEIVE', 50, {
    id: 'later-late',
    occurredAt: new Date('2026-09-07T10:00:00Z'),
    recordedAt: new Date('2026-09-07T10:05:00Z'),
    importedAt: new Date('2026-09-12T09:00:00Z'),
    sourceSystemId: 'nory',
  });
  const reopened = analyseMaterialVariance(input({
    movements: [reviewedReceipt, laterCorrection],
    movementWatermarkObservedAt: new Date('2026-09-11T09:00:00Z'),
    movementKnowledgePolicy: {
      automatedClaimedAtBySource: { nory: new Date('2026-09-10T09:00:00Z') },
      manualClaimedAt: null,
    },
  }));
  assert.equal(reopened.state, 'PROVISIONAL');
  assert.equal(reopened.lateRecordedMovementCount, 1);
  assert.deepEqual(reopened.evidence.lateMovementIds, ['later-late']);
});

test('suspected duplicate receipt blocks CLOSED material variance instead of reporting phantom loss', () => {
  const t = new Date('2026-09-07T12:00:00Z');
  const out = analyseMaterialVariance(input({
    movements: [
      movement('RECEIVE', 6800, { id: 'receipt-a', occurredAt: t }),
      movement('RECEIVE', 6800, { id: 'receipt-b', occurredAt: new Date(t.getTime() + 60_000) }),
    ],
  }));

  assert.equal(out.state, 'INCOMPLETE');
  assert.equal(out.actualConsumption, null);
  assert.equal(out.theoreticalConsumption, null);
  assert.equal(out.varianceQuantity, null);
  assert.equal(out.varianceCost, null);
  assert.ok(out.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'));
  assert.deepEqual(
    new Set(out.evidence.suspectedDuplicateMovementIds),
    new Set(['receipt-a', 'receipt-b']),
  );
});

test('duplicate detection catches a pair straddling the opening count boundary', () => {
  const out = analyseMaterialVariance(input({
    movements: [
      movement('RECEIVE', 200, {
        id: 'before-open',
        occurredAt: new Date('2026-09-01T06:59:00Z'),
      }),
      movement('RECEIVE', 200, {
        id: 'after-open',
        occurredAt: new Date('2026-09-01T07:01:00Z'),
      }),
    ],
  }));

  assert.equal(out.state, 'INCOMPLETE');
  assert.equal(out.actualConsumption, null);
  assert.ok(out.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'));
  assert.deepEqual(
    new Set(out.evidence.suspectedDuplicateMovementIds),
    new Set(['before-open', 'after-open']),
  );
});

test('duplicate-looking movements wholly after the closing count do not poison a closed interval', () => {
  const after = new Date('2026-09-15T08:00:00Z');
  const out = analyseMaterialVariance(input({
    movements: [
      movement('RECEIVE', 6800, { id: 'real-in-window' }),
      movement('RECEIVE', 200, { id: 'after-a', occurredAt: after }),
      movement('RECEIVE', 200, { id: 'after-b', occurredAt: new Date(after.getTime() + 60_000) }),
    ],
  }));

  assert.equal(out.state, 'CLOSED');
  assert.equal(out.varianceQuantity, 570);
  assert.ok(!out.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'));
  assert.deepEqual(out.evidence.suspectedDuplicateMovementIds, []);
});

test('duplicate zero-quantity rows do not block variance because they cannot change stock', () => {
  const t = new Date('2026-09-07T12:00:00Z');
  const out = analyseMaterialVariance(input({
    movements: [
      movement('RECEIVE', 6800, { id: 'real-receipt' }),
      movement('RECEIVE', 0, { id: 'zero-a', occurredAt: t }),
      movement('RECEIVE', 0, { id: 'zero-b', occurredAt: new Date(t.getTime() + 60_000) }),
    ],
  }));

  assert.equal(out.state, 'CLOSED');
  assert.equal(out.varianceQuantity, 570);
  assert.ok(!out.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'));
});
