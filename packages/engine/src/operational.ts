import { MOVEMENT_SIGN, type Movement, type ReconciliationOutput } from './types';
import { removeReversalPairs } from './movement-evidence';

export type OperationalDecision = 'ALLOCATE' | 'CUSTOMER_PROMISE' | 'PRODUCTION' | 'PURCHASE' | 'FINANCE';
export type DecisionDisposition = 'ALLOW' | 'HOLD' | 'BLOCK';

export interface DecisionAdvice {
  decision: OperationalDecision;
  disposition: DecisionDisposition;
  quantityLimit: number | null;
  reason: string;
}

export interface OperationalPositionInput {
  result: ReconciliationOutput;
  /** Movements that physically happened before the count but were recorded after it. */
  spanningMovements?: Movement[];
  /** Any other blocker means a bounded range would be dishonest. */
  hasUnboundedBlocker?: boolean;
}

export interface OperationalPosition {
  exactQuantity: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  omittedStockExposure: number | null;
  phantomStockExposure: number | null;
  advice: DecisionAdvice[];
}

/**
 * Convert evidence truth into decision guidance without changing the truth
 * result. A reconciliation may still say INCOMPLETE while a bounded range is
 * useful to an operator.
 *
 * Each ambiguous movement is treated independently. Positive spanning flow can
 * raise the current position; negative spanning flow can lower it. Netting the
 * two before building a range would create false certainty when opposite-sign
 * movements cancel each other numerically.
 */
export function assessOperationalPosition(input: OperationalPositionInput): OperationalPosition {
  const result = input.result;

  // A duplicate candidate has no honest bounded interpretation without a
  // resolution saying which postings were physically real. Never let a
  // previously-computed quantity or an unrelated spanning range launder that
  // ambiguity into shop-floor guidance.
  if (result.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT')) {
    return blockedPosition();
  }

  if (result.derivedQuantity != null) {
    const q = result.derivedQuantity;
    return {
      exactQuantity: q,
      lowerBound: q,
      upperBound: q,
      omittedStockExposure: 0,
      phantomStockExposure: 0,
      advice: exactAdvice(q, result.state === 'VERIFIED'),
    };
  }

  if (input.hasUnboundedBlocker || result.physicalQuantity == null || result.movementNet == null) {
    return blockedPosition();
  }

  const reversalNormalised = removeReversalPairs(input.spanningMovements ?? []);
  const spanning = reversalNormalised.effective;
  if (
    spanning.length === 0 ||
    spanning.some((m) => m.occurredAt == null) ||
    spanning.some((m) => !Number.isFinite(m.quantity) || m.quantity < 0) ||
    spanning.some((m) => m.type === 'ADJUST') ||
    reversalNormalised.orphanReversalIds.length > 0 ||
    reversalNormalised.invalidReversalIds.length > 0
  ) {
    return blockedPosition();
  }

  const countedPath = result.physicalQuantity + result.movementNet;
  let positiveExposure = 0;
  let negativeExposure = 0;

  for (const movement of spanning) {
    const impact = MOVEMENT_SIGN[movement.type] * movement.quantity;
    if (impact > 0) positiveExposure += impact;
    if (impact < 0) negativeExposure += Math.abs(impact);
  }

  // Stock cannot be allocated below zero. A negative mathematical floor means
  // the ambiguity is wider than the counted quantity, not that the warehouse
  // owns negative material. Clamp the operational floor at zero.
  const lower = Math.max(0, countedPath - negativeExposure);
  const upper = Math.max(lower, countedPath + positiveExposure);
  const width = upper - lower;

  return {
    exactQuantity: null,
    lowerBound: lower,
    upperBound: upper,
    omittedStockExposure: positiveExposure,
    phantomStockExposure: negativeExposure,
    advice: boundedAdvice(lower, width),
  };
}

function blockedPosition(): OperationalPosition {
  return {
    exactQuantity: null,
    lowerBound: null,
    upperBound: null,
    omittedStockExposure: null,
    phantomStockExposure: null,
    advice: blockedAdvice(),
  };
}

function exactAdvice(quantity: number, fullyVerified: boolean): DecisionAdvice[] {
  const finance: DecisionAdvice = fullyVerified
    ? { decision: 'FINANCE', disposition: 'ALLOW', quantityLimit: quantity, reason: 'Current position is physically anchored and verified.' }
    : { decision: 'FINANCE', disposition: 'HOLD', quantityLimit: null, reason: 'Operational quantity exists, but caveats remain for financial use.' };

  return [
    { decision: 'ALLOCATE', disposition: 'ALLOW', quantityLimit: quantity, reason: 'Use the supported current position.' },
    { decision: 'CUSTOMER_PROMISE', disposition: 'ALLOW', quantityLimit: quantity, reason: 'Use the supported current position.' },
    { decision: 'PRODUCTION', disposition: 'ALLOW', quantityLimit: quantity, reason: 'Use the supported current position.' },
    { decision: 'PURCHASE', disposition: 'ALLOW', quantityLimit: quantity, reason: 'No bounded quantity ambiguity remains.' },
    finance,
  ];
}

function boundedAdvice(lower: number, width: number): DecisionAdvice[] {
  return [
    { decision: 'ALLOCATE', disposition: 'ALLOW', quantityLimit: lower, reason: `Operate against the conservative floor; ${width} units remain unresolved.` },
    { decision: 'CUSTOMER_PROMISE', disposition: 'ALLOW', quantityLimit: lower, reason: `Promise only the conservative floor; ${width} units remain unresolved.` },
    { decision: 'PRODUCTION', disposition: 'ALLOW', quantityLimit: lower, reason: `Plan against the conservative floor; ${width} units remain unresolved.` },
    { decision: 'PURCHASE', disposition: 'HOLD', quantityLimit: null, reason: `Resolve the ${width}-unit range before replenishing.` },
    { decision: 'FINANCE', disposition: 'BLOCK', quantityLimit: null, reason: 'A bounded operational range is not an exact financial position.' },
  ];
}

function blockedAdvice(): DecisionAdvice[] {
  return (['ALLOCATE', 'CUSTOMER_PROMISE', 'PRODUCTION', 'PURCHASE', 'FINANCE'] as OperationalDecision[]).map(
    (decision) => ({ decision, disposition: 'BLOCK', quantityLimit: null, reason: 'Evidence does not support a bounded operational position.' }),
  );
}
