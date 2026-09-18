import {
  DEFAULT_POLICY,
  MOVEMENT_SIGN,
  type Movement,
  type ReconciliationInput,
  type ReconciliationOutput,
  type ReconciliationState,
} from './types';
import { type ReasonCode } from './reasons';

export const ENGINE_VERSION = '0.1.1';

const MS_PER_DAY = 86_400_000;
const MS_PER_MIN = 60_000;

/**
 * Reconcile one item at one location.
 *
 * The rule the whole thing is built on: a physical count is the anchor, and
 * everything after it is arithmetic on top of that anchor. The book figure is
 * not an anchor. It is a claim by a source system, useful for telling the
 * owner how wrong his records were at the moment somebody last looked, and
 * useless for saying what is on the shelf right now.
 *
 * The engine returns null for a quantity whenever the evidence does not
 * support exactly one answer. That null is the product. Everything else here
 * exists to work out honestly when to return it.
 */
export function reconcile(input: ReconciliationInput): ReconciliationOutput {
  const {
    item,
    locationId,
    book,
    count,
    movements,
    unlinkedMovementCount,
    possiblyRelatedUnlinkedCount,
    sources,
    policy = DEFAULT_POLICY,
    evaluatedAt,
  } = input;

  const reasons = new Set<ReasonCode>();
  const usedMovementIds: string[] = [];
  const ignoredMovementIds: string[] = [];

  const out = (state: ReconciliationState, extra: Partial<ReconciliationOutput> = {}): ReconciliationOutput => ({
    state,
    bookQuantity: book?.quantity ?? null,
    bookAsOf: book?.asOf ?? null,
    physicalQuantity: count?.quantity ?? null,
    physicalCountedAt: count?.countedAt ?? null,
    derivedQuantity: null,
    derivedAsOf: null,
    varianceAtCount: null,
    movementNet: null,
    movementWindowStart: null,
    movementWindowEnd: null,
    reasons: [...reasons],
    evidence: {
      bookSnapshotId: book?.id,
      countLineId: count?.id,
      movementIds: usedMovementIds,
      ignoredMovementIds,
    },
    ...extra,
  });

  // -------------------------------------------------------------------------
  // 1. Identity. Nothing downstream means anything if we are not sure what
  //    this item is, so these end the evaluation rather than adding a caveat.
  // -------------------------------------------------------------------------

  if (item.blocked) {
    reasons.add('ITEM_BLOCKED');
    return out('CONFLICT');
  }

  if (item.identityAmbiguous) {
    reasons.add('AMBIGUOUS_ITEM_IDENTITY');
    return out('CONFLICT');
  }

  if (!item.active && (count?.quantity ?? 0) > 0) {
    reasons.add('ITEM_INACTIVE');
  }

  // -------------------------------------------------------------------------
  // 2. Units. Adding 24 to 1 is wrong whether the 1 is a case or the 24 are
  //    singles, and guessing which is worse than refusing.
  // -------------------------------------------------------------------------

  if (book && book.unit !== item.stockUnit) {
    reasons.add('BOOK_UNIT_MISMATCH');
    return out('CONFLICT');
  }

  if (count && count.unit !== item.stockUnit) {
    reasons.add('COUNT_UNIT_MISMATCH');
    return out('CONFLICT');
  }

  const wrongUnitMovements = movements.filter((m) => m.unit !== item.stockUnit);
  if (wrongUnitMovements.length > 0) {
    reasons.add('MOVEMENT_UNIT_MISMATCH');
    for (const m of wrongUnitMovements) ignoredMovementIds.push(m.id);
    return out('CONFLICT');
  }

  // -------------------------------------------------------------------------
  // 3. Source health. A quiet feed is not the same as a feed with nothing to
  //    say, and we cannot tell the difference from inside, so we flag it and
  //    let it weaken the result rather than block it.
  // -------------------------------------------------------------------------

  for (const s of sources) {
    if (s.expectedSyncMinutes == null) continue; // manual, no expectation
    const silentFor = s.lastSuccessAt
      ? evaluatedAt.getTime() - s.lastSuccessAt.getTime()
      : Infinity;
    if (silentFor > s.expectedSyncMinutes * policy.sourceSilenceMultiplier * MS_PER_MIN) {
      reasons.add('SOURCE_FEED_STALE');
      break;
    }
  }

  // -------------------------------------------------------------------------
  // 4. No count. We can still show the book figure, but we will not pretend it
  //    is a position. Nobody has looked.
  // -------------------------------------------------------------------------

  if (!count) {
    reasons.add('NEVER_COUNTED');
    if (!book) reasons.add('NO_BOOK_POSITION');
    return out('UNVERIFIED');
  }

  // -------------------------------------------------------------------------
  // 5. Is the count itself trustworthy as a timestamp?
  // -------------------------------------------------------------------------

  if (count.countedAt.getTime() > evaluatedAt.getTime() + MS_PER_MIN) {
    reasons.add('COUNT_AFTER_EVALUATION');
    return out('CONFLICT');
  }

  const skewMs = Math.abs(count.receivedAt.getTime() - count.countedAt.getTime());
  // Only meaningful when the line arrived promptly. An offline count uploaded
  // the next morning has a huge gap by design and that is not skew.
  const arrivedPromptly = count.receivedAt.getTime() - count.countedAt.getTime() < 6 * 60 * MS_PER_MIN;
  if (arrivedPromptly && skewMs > policy.maxClockSkewMinutes * MS_PER_MIN) {
    reasons.add('CLOCK_SKEW');
  }

  if (policy.requireLocation && !locationId) {
    reasons.add('MISSING_LOCATION');
  }

  const countAgeDays = (evaluatedAt.getTime() - count.countedAt.getTime()) / MS_PER_DAY;
  const countIsStale = countAgeDays > policy.staleAfterDays;

  // -------------------------------------------------------------------------
  // 6. Movements since the count. This is the only arithmetic that produces a
  //    current position, and it only works if every movement can be placed in
  //    time relative to the count.
  // -------------------------------------------------------------------------

  // Unmatched rows anywhere at the site are worth saying out loud, but one
  // stray hop receipt does not make the malt count untrustworthy. It weakens
  // the result rather than withdrawing it.
  if (unlinkedMovementCount > 0) {
    reasons.add('UNMATCHED_MOVEMENTS_AT_SITE');
  }

  // Unless the unmatched row's own code points here. Then applying it or not
  // changes this item's number, and nothing says which is right.
  if (possiblyRelatedUnlinkedCount > 0) {
    reasons.add('MOVEMENT_MAY_BELONG_HERE');
  }

  const undated = movements.filter((m) => m.occurredAt == null);
  if (undated.length > 0) {
    reasons.add('MOVEMENT_UNDATED');
    for (const m of undated) ignoredMovementIds.push(m.id);
  }

  const dated = movements.filter((m): m is Movement & { occurredAt: Date } => m.occurredAt != null);

  // The case that started all this. A movement whose goods arrived before the
  // count but whose paperwork landed after it. Did the counter see those goods
  // or not? Nothing in the data says. Applying it double-counts; ignoring it
  // undercounts. So we decline to produce a number and say why.
  const spanning = dated.filter(
    (m) =>
      m.occurredAt.getTime() <= count.countedAt.getTime() &&
      m.recordedAt != null &&
      m.recordedAt.getTime() > count.countedAt.getTime(),
  );
  if (spanning.length > 0) {
    reasons.add('MOVEMENT_SPANS_COUNT');
    for (const m of spanning) ignoredMovementIds.push(m.id);
  }

  // Stock that moved while the session was open is a softer version of the
  // same problem: the counter was in the building, but we do not know whether
  // they had already walked past that shelf.
  if (count.sessionWatermark) {
    const duringSession = dated.filter(
      (m) =>
        m.occurredAt.getTime() >= count.sessionWatermark!.getTime() &&
        m.occurredAt.getTime() <= count.countedAt.getTime() &&
        !spanning.includes(m),
    );
    if (duringSession.length > 0) reasons.add('MOVEMENT_DURING_OPEN_COUNT');
  }

  flagSuspectedDuplicates(dated, reasons);

  // Movements strictly after the count are the ones we apply.
  const afterCount = dated
    .filter((m) => m.occurredAt.getTime() > count.countedAt.getTime())
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const netAfter = afterCount.reduce((sum, m) => sum + MOVEMENT_SIGN[m.type] * m.quantity, 0);
  for (const m of afterCount) usedMovementIds.push(m.id);

  const derived = count.quantity + netAfter;

  // -------------------------------------------------------------------------
  // 7. Variance at the moment of counting. Separate question from "what is on
  //    the shelf now", and separately answerable. This is the number that
  //    tells an owner how far his records had drifted, and it only exists when
  //    the book can be carried forward to the count without assuming anything.
  // -------------------------------------------------------------------------

  let varianceAtCount: number | null = null;

  if (!book) {
    reasons.add('NO_BOOK_POSITION');
  } else if (book.asOf == null) {
    reasons.add('BOOK_UNDATED');
  } else {
    const bookAgeDays = (count.countedAt.getTime() - book.asOf.getTime()) / MS_PER_DAY;
    if (bookAgeDays > policy.bookStaleAfterDays) {
      reasons.add('BOOK_STALE');
    }

    const between = dated.filter(
      (m) =>
        m.occurredAt.getTime() > book.asOf!.getTime() &&
        m.occurredAt.getTime() <= count.countedAt.getTime(),
    );

    // The window has to be complete and unambiguous, or the comparison is a
    // subtraction of two numbers that do not describe the same moment.
    const windowTrustworthy =
      undated.length === 0 &&
      spanning.length === 0 &&
      possiblyRelatedUnlinkedCount === 0 &&
      !reasons.has('BOOK_STALE');

    if (windowTrustworthy) {
      const netBetween = between.reduce((sum, m) => sum + MOVEMENT_SIGN[m.type] * m.quantity, 0);
      varianceAtCount = count.quantity - (book.quantity + netBetween);
    }
  }

  // -------------------------------------------------------------------------
  // 8. Contradiction beats everything below it.
  // -------------------------------------------------------------------------

  if (derived < 0) {
    reasons.add('NEGATIVE_DERIVED_POSITION');
    return out('CONFLICT', {
      movementNet: netAfter,
      movementWindowStart: count.countedAt,
      movementWindowEnd: evaluatedAt,
      varianceAtCount,
    });
  }

  // -------------------------------------------------------------------------
  // 9. State. Blocking problems first, then age, then caveats.
  // -------------------------------------------------------------------------

  const blocking: ReasonCode[] = [
    'MOVEMENT_UNDATED',
    'MOVEMENT_SPANS_COUNT',
    'MOVEMENT_MAY_BELONG_HERE',
  ];
  const isBlocked = blocking.some((c) => reasons.has(c));

  const common = {
    movementNet: netAfter,
    movementWindowStart: count.countedAt,
    movementWindowEnd: evaluatedAt,
    varianceAtCount,
  };

  if (isBlocked) {
    // We know what was counted. We cannot say what is there now.
    return out('INCOMPLETE', common);
  }

  if (countIsStale) {
    reasons.add('COUNT_STALE');
    // The arithmetic still holds, but a figure resting on a count from months
    // ago is not something to put in front of someone as current.
    return out('STALE', { ...common, derivedQuantity: derived, derivedAsOf: evaluatedAt });
  }

  const softCaveats: ReasonCode[] = [
    'UNMATCHED_MOVEMENTS_AT_SITE',
    'SOURCE_FEED_STALE',
    'MOVEMENT_DURING_OPEN_COUNT',
    'SUSPECTED_DUPLICATE_MOVEMENT',
    'CLOCK_SKEW',
    'BOOK_STALE',
    'BOOK_UNDATED',
    'MISSING_LOCATION',
    'ITEM_INACTIVE',
    'NO_BOOK_POSITION',
  ];
  const hasCaveat = softCaveats.some((c) => reasons.has(c));

  return out(hasCaveat ? 'PROVISIONAL' : 'VERIFIED', {
    ...common,
    derivedQuantity: derived,
    derivedAsOf: evaluatedAt,
  });
}

/**
 * Two identical movements minutes apart are usually one delivery entered
 * twice, and occasionally two real deliveries. We never merge them, because
 * merging a real pair loses stock silently. We raise it and let a person look.
 */
function flagSuspectedDuplicates(
  movements: (Movement & { occurredAt: Date })[],
  reasons: Set<ReasonCode>,
): void {
  const WINDOW_MS = 5 * MS_PER_MIN;
  const sorted = [...movements].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (!a || !b) continue;
    const sameShape = a.type === b.type && a.quantity === b.quantity;
    const closeInTime = b.occurredAt.getTime() - a.occurredAt.getTime() <= WINDOW_MS;
    // A reversal pair looks identical by design and is not a duplicate.
    const isReversalPair = b.reversalOfId === a.id || a.reversalOfId === b.id;
    if (sameShape && closeInTime && !isReversalPair) {
      reasons.add('SUSPECTED_DUPLICATE_MOVEMENT');
      return;
    }
  }
}
