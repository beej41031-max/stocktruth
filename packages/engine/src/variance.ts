import { type Movement, type MovementType } from './types';
import { findSuspectedDuplicateMovementGroups, removeReversalPairs } from './movement-evidence';

/**
 * Material variance turns two physical observations into a measurement period.
 *
 * Interval boundary convention: (opening, closing]. A movement or production
 * event exactly at the opening count is assumed to be embodied in that count;
 * one exactly at the closing time is part of the interval immediately before
 * the closing observation. This convention is deliberate and documented so
 * adapters cannot drift into different cutoff rules.
 */

export type MaterialVarianceState =
  | 'CLOSED'
  | 'PROVISIONAL'
  | 'ACTUAL_ONLY'
  | 'INCOMPLETE'
  | 'CONFLICT';

export type MaterialVarianceReason =
  | 'COUNT_ORDER_INVALID'
  | 'COUNT_UNIT_MISMATCH'
  | 'COUNT_CLOCK_SKEW'
  | 'MOVEMENT_UNIT_MISMATCH'
  | 'MOVEMENT_UNDATED'
  | 'ORPHAN_REVERSAL'
  | 'INVALID_REVERSAL_PAIR'
  | 'ADJUSTMENT_IN_INTERVAL'
  | 'SUSPECTED_DUPLICATE_MOVEMENT'
  | 'SOURCE_NOT_SETTLED_THROUGH_CLOSE'
  | 'PRODUCTION_NOT_SETTLED_THROUGH_CLOSE'
  | 'LATE_RECORDED_MOVEMENT'
  | 'LATE_RECORDED_PRODUCTION'
  | 'MISSING_BOM'
  | 'AMBIGUOUS_BOM'
  | 'BOM_UNIT_MISMATCH'
  | 'OUTPUT_UNIT_MISMATCH'
  | 'THEORY_SCOPE_AMBIGUOUS'
  | 'NEGATIVE_ACTUAL_CONSUMPTION';

export interface PhysicalObservation {
  id: string;
  quantity: number;
  unit: string;
  /** Device/event time of the physical observation. */
  countedAt: Date;
  /** Server receive time. Optional for non-database adapters/tests. */
  receivedAt?: Date;
}

export interface ProductionOutput {
  id: string;
  productId: string;
  quantity: number;
  unit: string;
  /** Completion time, not the time somebody keyed the run into a system. */
  completedAt: Date;
  /** Source bookkeeping time. It may be backdated and is not StockTruth knowledge time. */
  recordedAt: Date | null;
  /** When StockTruth learned this output. */
  importedAt: Date;
  sourceSystemId: string | null;
}

export interface BomLine {
  itemId: string;
  quantityPerOutput: number;
  unit: string;
}

export interface BomVersion {
  id: string;
  productId: string;
  /** The unit in which production output for this product is expressed. */
  outputUnit: string;
  validFrom: Date;
  /** Exclusive. Null means still effective. */
  validTo: Date | null;
  lines: BomLine[];
}

export interface EvidenceKnowledgePolicy {
  /** Knowledge time of each automated source's own completeness claim. */
  automatedClaimedAtBySource: Readonly<Record<string, Date | null>>;
  /** Knowledge time of the office assertion covering manual/null sources. */
  manualClaimedAt: Date | null;
}

export interface MaterialVarianceInput {
  itemId: string;
  unit: string;
  opening: PhysicalObservation;
  closing: PhysicalObservation;
  /** All movements for the item/location; the engine selects the interval. */
  movements: Movement[];
  production: ProductionOutput[];
  boms: BomVersion[];
  /** Event-time completeness of the external-flow evidence. */
  movementWatermark: Date | null;
  /** When the combined movement completeness claim itself was known/asserted. */
  movementWatermarkObservedAt?: Date | null;
  /** Optional source-specific knowledge times, used so a later manual claim cannot hide a late automated row. */
  movementKnowledgePolicy?: EvidenceKnowledgePolicy;
  /** Event-time completeness of production-output evidence. */
  productionWatermark: Date | null;
  /** When the combined production completeness claim itself was known/asserted. */
  productionWatermarkObservedAt?: Date | null;
  /** Optional source-specific knowledge times for production evidence. */
  productionKnowledgePolicy?: EvidenceKnowledgePolicy;
  /**
   * False when production is site-wide but the physical interval is only one
   * of several locations and there is no defensible allocation of theory to it.
   */
  theoryScopeComplete?: boolean;
  /** Standard/actual unit cost for translating quantity variance into money. */
  unitCost?: number | null;
  /** Same prompt-upload skew threshold used by current-position reconciliation. */
  maxClockSkewMinutes?: number;
}

export interface MaterialVarianceOutput {
  state: MaterialVarianceState;
  openingQuantity: number;
  closingQuantity: number;
  intervalStart: Date;
  intervalEnd: Date;
  intervalDays: number;

  receipts: number;
  transferIn: number;
  returnsIn: number;
  transferOut: number;
  /** Recorded ISSUE + WASTE, shown only as an explanatory subset. */
  recordedConsumption: number;

  /** Residual physical use measured by the two counts plus external flows. */
  actualConsumption: number | null;
  theoreticalConsumption: number | null;
  varianceQuantity: number | null;
  variancePercent: number | null;
  varianceCost: number | null;
  unitCost: number | null;

  movementWatermark: Date | null;
  movementWatermarkObservedAt: Date | null;
  productionWatermark: Date | null;
  productionWatermarkObservedAt: Date | null;
  lateRecordedMovementCount: number;
  lateRecordedProductionCount: number;
  productionOutputCount: number;
  bomVersionIds: string[];
  reasons: MaterialVarianceReason[];
  evidence: {
    openingCountId: string;
    closingCountId: string;
    movementIds: string[];
    lateMovementIds: string[];
    ignoredReversalMovementIds: string[];
    suspectedDuplicateMovementIds: string[];
    productionOutputIds: string[];
    lateProductionOutputIds: string[];
  };
}

export function analyseMaterialVariance(input: MaterialVarianceInput): MaterialVarianceOutput {
  const reasons = new Set<MaterialVarianceReason>();
  const start = input.opening.countedAt;
  const end = input.closing.countedAt;

  const base = (): MaterialVarianceOutput => ({
    state: 'INCOMPLETE',
    openingQuantity: input.opening.quantity,
    closingQuantity: input.closing.quantity,
    intervalStart: start,
    intervalEnd: end,
    intervalDays: Math.max(0, (end.getTime() - start.getTime()) / 86_400_000),
    receipts: 0,
    transferIn: 0,
    returnsIn: 0,
    transferOut: 0,
    recordedConsumption: 0,
    actualConsumption: null,
    theoreticalConsumption: null,
    varianceQuantity: null,
    variancePercent: null,
    varianceCost: null,
    unitCost: input.unitCost ?? null,
    movementWatermark: input.movementWatermark,
    movementWatermarkObservedAt: input.movementWatermarkObservedAt ?? null,
    productionWatermark: input.productionWatermark,
    productionWatermarkObservedAt: input.productionWatermarkObservedAt ?? null,
    lateRecordedMovementCount: 0,
    lateRecordedProductionCount: 0,
    productionOutputCount: 0,
    bomVersionIds: [],
    reasons: [...reasons],
    evidence: {
      openingCountId: input.opening.id,
      closingCountId: input.closing.id,
      movementIds: [],
      lateMovementIds: [],
      ignoredReversalMovementIds: [],
      suspectedDuplicateMovementIds: [],
      productionOutputIds: [],
      lateProductionOutputIds: [],
    },
  });

  if (end.getTime() <= start.getTime()) {
    reasons.add('COUNT_ORDER_INVALID');
    return { ...base(), state: 'CONFLICT', reasons: [...reasons] };
  }

  if (input.opening.unit !== input.unit || input.closing.unit !== input.unit) {
    reasons.add('COUNT_UNIT_MISMATCH');
    return { ...base(), state: 'CONFLICT', reasons: [...reasons] };
  }

  const maxClockSkewMinutes = input.maxClockSkewMinutes ?? 10;
  if (
    observationHasClockSkew(input.opening, maxClockSkewMinutes) ||
    observationHasClockSkew(input.closing, maxClockSkewMinutes)
  ) {
    reasons.add('COUNT_CLOCK_SKEW');
    return { ...base(), state: 'CONFLICT', reasons: [...reasons] };
  }

  const reversalNormalised = removeReversalPairs(input.movements);
  if (reversalNormalised.orphanReversalIds.length > 0) reasons.add('ORPHAN_REVERSAL');
  if (reversalNormalised.invalidReversalIds.length > 0) reasons.add('INVALID_REVERSAL_PAIR');
  const movements = reversalNormalised.effective;

  // An undated row already known before the opening count is absorbed by that
  // observation. One learned after opening cannot be placed in the interval.
  const undated = movements.filter((m) => {
    if (m.occurredAt != null) return false;
    const knownAt = m.importedAt;
    return knownAt.getTime() > start.getTime();
  });
  if (undated.length > 0) reasons.add('MOVEMENT_UNDATED');

  const datedInWindow = movements.filter(
    (m): m is Movement & { occurredAt: Date } =>
      m.occurredAt != null &&
      m.occurredAt.getTime() > start.getTime() &&
      m.occurredAt.getTime() <= end.getTime(),
  );

  const wrongUnits = datedInWindow.filter((m) => m.unit !== input.unit);
  if (wrongUnits.length > 0) reasons.add('MOVEMENT_UNIT_MISMATCH');
  if (datedInWindow.some((m) => m.type === 'ADJUST')) reasons.add('ADJUSTMENT_IN_INTERVAL');

  // Detect duplicates across the whole reversal-normalised evidence set, not
  // only rows already selected into the interval. A duplicate pair can straddle
  // the opening or closing count by a minute and still make the interval's
  // arithmetic ambiguous. If any member of a suspected group touches
  // (opening, closing], exact actual consumption is not defensible.
  const duplicateGroups = findSuspectedDuplicateMovementGroups(movements);
  const intervalDuplicateGroups = duplicateGroups.filter((group) =>
    group.movements.some(
      (m) => m.occurredAt.getTime() > start.getTime() && m.occurredAt.getTime() <= end.getTime(),
    ),
  );
  const suspectedDuplicateMovementIds = [
    ...new Set(intervalDuplicateGroups.flatMap((group) => group.movementIds)),
  ];
  if (suspectedDuplicateMovementIds.length > 0) reasons.add('SUSPECTED_DUPLICATE_MOVEMENT');

  const blockers: MaterialVarianceReason[] = [
    'MOVEMENT_UNDATED',
    'MOVEMENT_UNIT_MISMATCH',
    'ORPHAN_REVERSAL',
    'INVALID_REVERSAL_PAIR',
    'ADJUSTMENT_IN_INTERVAL',
    'SUSPECTED_DUPLICATE_MOVEMENT',
  ];

  const receipts = sumType(datedInWindow, 'RECEIVE');
  const transferIn = sumType(datedInWindow, 'TRANSFER_IN');
  const returnsIn = sumType(datedInWindow, 'RETURN');
  const transferOut = sumType(datedInWindow, 'TRANSFER_OUT');
  const recordedConsumption = sumType(datedInWindow, 'ISSUE') + sumType(datedInWindow, 'WASTE');

  // A source-local recorded_at is not StockTruth knowledge time. Manual/CSV
  // rows can be backdated. importedAt is when StockTruth actually learned the
  // evidence; only arrival after the completeness claim can reopen closure.
  const movementClaimedAt = input.movementWatermarkObservedAt ?? null;
  const lateRecorded = datedInWindow.filter((m) => {
    const sourceClaim = evidenceClaimedAt(
      m.sourceSystemId,
      input.movementKnowledgePolicy,
      movementClaimedAt,
    );
    return sourceClaim != null && m.importedAt.getTime() > sourceClaim.getTime();
  });
  if (lateRecorded.length > 0) reasons.add('LATE_RECORDED_MOVEMENT');

  const movementSettled =
    input.movementWatermark != null &&
    movementClaimedAt != null &&
    input.movementWatermark.getTime() >= end.getTime() &&
    lateRecorded.length === 0;
  if (!movementSettled) reasons.add('SOURCE_NOT_SETTLED_THROUGH_CLOSE');

  const common = {
    ...base(),
    receipts,
    transferIn,
    returnsIn,
    transferOut,
    recordedConsumption,
    lateRecordedMovementCount: lateRecorded.length,
    evidence: {
      ...base().evidence,
      movementIds: datedInWindow.map((m) => m.id),
      lateMovementIds: lateRecorded.map((m) => m.id),
      ignoredReversalMovementIds: reversalNormalised.removedIds,
      suspectedDuplicateMovementIds,
    },
  };

  if (blockers.some((b) => reasons.has(b))) {
    return { ...common, state: 'INCOMPLETE', reasons: [...reasons] };
  }

  const actual = input.opening.quantity + receipts + transferIn + returnsIn - transferOut - input.closing.quantity;
  if (actual < 0) {
    reasons.add('NEGATIVE_ACTUAL_CONSUMPTION');
    return { ...common, state: 'CONFLICT', actualConsumption: actual, reasons: [...reasons] };
  }

  const production = input.production.filter(
    (p) => p.completedAt.getTime() > start.getTime() && p.completedAt.getTime() <= end.getTime(),
  );
  const productionClaimedAt = input.productionWatermarkObservedAt ?? null;
  const lateProduction = production.filter((p) => {
    const sourceClaim = evidenceClaimedAt(
      p.sourceSystemId,
      input.productionKnowledgePolicy,
      productionClaimedAt,
    );
    return sourceClaim != null && p.importedAt.getTime() > sourceClaim.getTime();
  });
  if (lateProduction.length > 0) reasons.add('LATE_RECORDED_PRODUCTION');

  const productionSettled =
    input.productionWatermark != null &&
    productionClaimedAt != null &&
    input.productionWatermark.getTime() >= end.getTime() &&
    lateProduction.length === 0;
  if (!productionSettled) reasons.add('PRODUCTION_NOT_SETTLED_THROUGH_CLOSE');

  if (input.theoryScopeComplete === false) reasons.add('THEORY_SCOPE_AMBIGUOUS');

  const productionCommon = {
    ...common,
    actualConsumption: actual,
    productionOutputCount: production.length,
    productionWatermark: input.productionWatermark,
    productionWatermarkObservedAt: productionClaimedAt,
    lateRecordedProductionCount: lateProduction.length,
    evidence: {
      ...common.evidence,
      productionOutputIds: production.map((p) => p.id),
      lateProductionOutputIds: lateProduction.map((p) => p.id),
    },
  };

  // Actual physical use can still be valuable when theory is unavailable. But
  // without a closed production feed, a zero-output theory is not evidence of
  // zero production and must never become a false adverse variance.
  if (!productionSettled || input.theoryScopeComplete === false) {
    return {
      ...productionCommon,
      state: movementSettled ? 'ACTUAL_ONLY' : 'PROVISIONAL',
      theoreticalConsumption: null,
      varianceQuantity: null,
      variancePercent: null,
      varianceCost: null,
      reasons: [...reasons],
    };
  }

  let theory = 0;
  const bomVersionIds = new Set<string>();
  let theoryComplete = true;

  for (const output of production) {
    const effective = input.boms.filter(
      (b) =>
        b.productId === output.productId &&
        b.validFrom.getTime() <= output.completedAt.getTime() &&
        (b.validTo == null || output.completedAt.getTime() < b.validTo.getTime()),
    );

    if (effective.length === 0) {
      reasons.add('MISSING_BOM');
      theoryComplete = false;
      continue;
    }
    if (effective.length > 1) {
      reasons.add('AMBIGUOUS_BOM');
      theoryComplete = false;
      continue;
    }

    const bom = effective[0]!;
    bomVersionIds.add(bom.id);
    if (output.unit !== bom.outputUnit) {
      reasons.add('OUTPUT_UNIT_MISMATCH');
      theoryComplete = false;
      continue;
    }

    const lines = bom.lines.filter((line) => line.itemId === input.itemId);
    for (const line of lines) {
      if (line.unit !== input.unit) {
        reasons.add('BOM_UNIT_MISMATCH');
        theoryComplete = false;
        continue;
      }
      theory += output.quantity * line.quantityPerOutput;
    }
  }

  const theoryBlockers: MaterialVarianceReason[] = [
    'MISSING_BOM',
    'AMBIGUOUS_BOM',
    'BOM_UNIT_MISMATCH',
    'OUTPUT_UNIT_MISMATCH',
  ];
  if (!theoryComplete || theoryBlockers.some((r) => reasons.has(r))) {
    return {
      ...productionCommon,
      state: movementSettled ? 'ACTUAL_ONLY' : 'PROVISIONAL',
      theoreticalConsumption: null,
      bomVersionIds: [...bomVersionIds],
      reasons: [...reasons],
    };
  }

  const variance = actual - theory;
  const pct = theory === 0 ? null : (variance / theory) * 100;
  const cost = input.unitCost == null ? null : variance * input.unitCost;

  return {
    ...productionCommon,
    state: movementSettled ? 'CLOSED' : 'PROVISIONAL',
    theoreticalConsumption: theory,
    varianceQuantity: variance,
    variancePercent: pct,
    varianceCost: cost,
    bomVersionIds: [...bomVersionIds],
    reasons: [...reasons],
  };
}

function observationHasClockSkew(observation: PhysicalObservation, maxClockSkewMinutes: number): boolean {
  if (!observation.receivedAt) return false;
  const minute = 60_000;
  const rawDelay = observation.receivedAt.getTime() - observation.countedAt.getTime();
  // A genuinely offline count can arrive hours later by design. Match the
  // current-position engine: only prompt arrivals make server-v-device skew a
  // useful clock-quality signal.
  const arrivedPromptly = rawDelay < 6 * 60 * minute;
  return arrivedPromptly && Math.abs(rawDelay) > maxClockSkewMinutes * minute;
}

function evidenceClaimedAt(
  sourceSystemId: string | null,
  policy: EvidenceKnowledgePolicy | undefined,
  fallback: Date | null,
): Date | null {
  if (!policy) return fallback;
  if (sourceSystemId != null && Object.prototype.hasOwnProperty.call(policy.automatedClaimedAtBySource, sourceSystemId)) {
    return policy.automatedClaimedAtBySource[sourceSystemId] ?? null;
  }
  return policy.manualClaimedAt;
}

function sumType(movements: Movement[], type: MovementType): number {
  return movements.filter((m) => m.type === type).reduce((sum, m) => sum + m.quantity, 0);
}

export interface VerificationCandidateInput {
  itemId: string;
  unitCost: number | null;
  uncertaintyQuantity: number | null;
  historicalVarianceCost: number;
  historicalVarianceQuantity?: number;
  unsettledVarianceCost: number;
  daysSinceCount: number;
  targetCycleDays: number;
}

export interface VerificationCandidate {
  itemId: string;
  economicExposure: number | null;
  overdueRatio: number;
  priorityScore: number;
  priorityBasis: 'COST' | 'QUANTITY' | 'CADENCE';
  why: string;
}

/** Transparent value-of-information ranking without inventing confidence. */
export function scoreVerificationCandidate(input: VerificationCandidateInput): VerificationCandidate {
  const target = Math.max(1, input.targetCycleDays);
  const overdueRatio = Math.max(0, input.daysSinceCount / target);
  const urgencyMultiplier = 1 + Math.min(2, Math.max(0, overdueRatio - 1));

  if (input.unitCost != null) {
    const uncertaintyCost = input.uncertaintyQuantity == null ? 0 : Math.abs(input.uncertaintyQuantity * input.unitCost);
    const economicExposure = Math.max(
      uncertaintyCost,
      Math.abs(input.historicalVarianceCost),
      Math.abs(input.unsettledVarianceCost),
    );
    const priorityScore = economicExposure * urgencyMultiplier;
    const driver =
      economicExposure === Math.abs(input.unsettledVarianceCost) && economicExposure > 0
        ? 'unsettled material variance'
        : economicExposure === Math.abs(input.historicalVarianceCost) && economicExposure > 0
          ? 'historical material variance'
          : uncertaintyCost > 0
            ? 'current quantity uncertainty'
            : 'the agreed count cadence';
    return {
      itemId: input.itemId,
      economicExposure,
      overdueRatio,
      priorityScore: priorityScore > 0 ? priorityScore : Math.max(0.01, overdueRatio),
      priorityBasis: economicExposure > 0 ? 'COST' : 'CADENCE',
      why: economicExposure > 0
        ? `Count because ${driver} exposes about ${economicExposure.toFixed(2)} of value`
        : 'Count because the agreed cadence is due; no priced exposure is available yet',
    };
  }

  const quantitySignal = Math.max(
    Math.abs(input.uncertaintyQuantity ?? 0),
    Math.abs(input.historicalVarianceQuantity ?? 0),
  );
  if (quantitySignal > 0) {
    return {
      itemId: input.itemId,
      economicExposure: null,
      overdueRatio,
      priorityScore: quantitySignal * urgencyMultiplier,
      priorityBasis: 'QUANTITY',
      why: `Count because ${quantitySignal.toFixed(2)} units are materially exposed; unit cost is missing`,
    };
  }

  return {
    itemId: input.itemId,
    economicExposure: null,
    overdueRatio,
    priorityScore: Math.max(0.01, overdueRatio),
    priorityBasis: 'CADENCE',
    why: 'Count because the agreed cadence is due; unit cost is missing',
  };
}

/**
 * Verification priorities are only comparable within the same measurement
 * domain. A quantity score from an unpriced item must never numerically outrank
 * a monetary exposure. Priced candidates come first; each group then uses its
 * own transparent score.
 */
export function compareVerificationCandidates(a: VerificationCandidate, b: VerificationCandidate): number {
  const aPriced = a.economicExposure != null;
  const bPriced = b.economicExposure != null;
  if (aPriced !== bPriced) return aPriced ? -1 : 1;
  return b.priorityScore - a.priorityScore;
}
