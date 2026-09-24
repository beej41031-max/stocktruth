/**
 * The shapes the reconciler works over.
 *
 * These are deliberately not the database rows. The engine takes evidence and
 * returns a conclusion; it does not know about Supabase, and it never reads or
 * writes anything. That is what makes it testable against nasty cases without
 * standing up a database to hold them.
 */

export type Quantity = number;

export type ReconciliationState =
  | 'VERIFIED'
  | 'PROVISIONAL'
  | 'STALE'
  | 'INCOMPLETE'
  | 'CONFLICT'
  | 'UNVERIFIED';

export type MovementType =
  | 'RECEIVE'
  | 'ISSUE'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'ADJUST'
  | 'WASTE'
  | 'RETURN';

/** Which way each movement type pushes the quantity. */
export const MOVEMENT_SIGN: Record<MovementType, 1 | -1> = {
  RECEIVE: 1,
  TRANSFER_IN: 1,
  RETURN: 1,
  ISSUE: -1,
  TRANSFER_OUT: -1,
  WASTE: -1,
  // ADJUST is retained as a source movement type, but reconciliation does not
  // infer its direction from this sign. A bare adjustment is semantically
  // ambiguous and is blocked unless an adapter maps it to an explicit flow.
  // The +1 here is only for code paths that have already established meaning.
  ADJUST: 1,
};

export interface ItemRef {
  id: string;
  sku: string | null;
  name: string;
  stockUnit: string;
  active: boolean;
  /** Set when the business has flagged the code itself as unsafe to use. */
  blocked: boolean;
  blockedReason?: string | null;
  /**
   * True when a label used to reach this item resolves to more than one item.
   * Nothing derived from an ambiguous identity can be trusted.
   */
  identityAmbiguous?: boolean;
}

export interface BookSnapshot {
  id: string;
  quantity: Quantity;
  unit: string;
  /** Null means the source never said when this was true. */
  asOf: Date | null;
  sourceSystemId: string | null;
}

export interface CountLine {
  id: string;
  quantity: Quantity;
  unit: string;
  /** Device clock at the moment of counting. */
  countedAt: Date;
  /** Server clock when the line arrived. */
  receivedAt: Date;
  countedBy: string | null;
  sessionId: string;
  /** Watermark of the movement feed when the session opened, if known. */
  sessionWatermark: Date | null;
}

export interface Movement {
  id: string;
  type: MovementType;
  quantity: Quantity;
  unit: string;
  /** When the goods moved. Null when the source did not say. */
  occurredAt: Date | null;
  /** When someone wrote it down. Null when the source did not say. */
  recordedAt: Date | null;
  /** When StockTruth learned it. Always known; this is the knowledge clock. */
  importedAt: Date;
  sourceSystemId: string | null;
  reversalOfId?: string | null;
}

export interface SourceHealth {
  sourceSystemId: string;
  name: string;
  /** Null for manual sources, which carry no freshness expectation. */
  expectedSyncMinutes: number | null;
  lastSuccessAt: Date | null;
}

export interface ReconciliationPolicy {
  staleAfterDays: number;
  bookStaleAfterDays: number;
  sourceSilenceMultiplier: number;
  maxClockSkewMinutes: number;
  requireLocation: boolean;
}

export const DEFAULT_POLICY: ReconciliationPolicy = {
  staleAfterDays: 30,
  bookStaleAfterDays: 14,
  sourceSilenceMultiplier: 3,
  maxClockSkewMinutes: 10,
  requireLocation: false,
};

export interface ReconciliationInput {
  item: ItemRef;
  locationId: string | null;
  book: BookSnapshot | null;
  count: CountLine | null;
  /** Movements for this item and location, any order. */
  movements: Movement[];
  /**
   * Movements at this site that could not be attached to any item. A site-wide
   * data-health problem: worth saying, but it does not by itself make this
   * item's history incomplete.
   */
  unlinkedMovementCount: number;
  /**
   * Of those, the ones whose own source code plausibly points at this item.
   * These do block a position, because applying them or not changes this
   * item's number and nothing tells us which is right.
   */
  possiblyRelatedUnlinkedCount: number;
  sources: SourceHealth[];
  policy: ReconciliationPolicy;
  /** Everything is judged as at this instant, so a run is reproducible. */
  evaluatedAt: Date;
  /**
   * False when the host is known to change stock in ways its movement feed
   * cannot show: a SaaS platform whose API exposes orders but not manual
   * adjustments, say. Defaults to true. See decision 0025.
   */
  movementFeedComplete?: boolean;
}

export interface ReconciliationOutput {
  state: ReconciliationState;

  bookQuantity: Quantity | null;
  bookAsOf: Date | null;
  physicalQuantity: Quantity | null;
  physicalCountedAt: Date | null;

  /**
   * What we believe is on the shelf now. Null whenever the evidence does not
   * support a single answer, which is the point of the whole system.
   */
  derivedQuantity: Quantity | null;
  derivedAsOf: Date | null;

  /**
   * How wrong the book was at the moment of counting, where that is
   * computable. Null is not zero.
   */
  varianceAtCount: Quantity | null;

  movementNet: Quantity | null;
  movementWindowStart: Date | null;
  movementWindowEnd: Date | null;

  reasons: string[];
  evidence: {
    bookSnapshotId?: string;
    countLineId?: string;
    movementIds: string[];
    ignoredMovementIds: string[];
  };
}
