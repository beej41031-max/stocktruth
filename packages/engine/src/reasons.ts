/**
 * Reason codes.
 *
 * Every state the engine returns carries at least one of these. A state on its
 * own ("INCOMPLETE") tells someone nothing they can act on; a reason tells them
 * what to go and fix.
 *
 * The text here is what the customer reads, so it says what happened and what
 * would resolve it, in the words a stock controller would use rather than the
 * words the schema uses.
 */

export interface ReasonDefinition {
  code: string;
  severity: 'high' | 'medium' | 'low';
  /** One line, shown in queues and on the item. */
  short: string;
  /** What someone should do about it. */
  action: string;
  /**
   * True when this reason on its own stops a current position being stated.
   *
   * This is the property that makes a refusal checkable. "Cannot be stated" is
   * not a judgement call made in prose somewhere; it is exactly the condition
   * that at least one blocking reason is present, and removing every blocking
   * reason will make a number appear.
   */
  blocks: boolean;
  /**
   * The evidence that would clear it, in the terms of the data model rather
   * than in terms of what somebody should go and do. Used to answer "what
   * would make this stateable again" without anyone having to reason it out.
   */
  remedy: string;
}

export const REASONS = {
  // --- identity ------------------------------------------------------------
  ITEM_BLOCKED: {
    code: 'ITEM_BLOCKED',
    severity: 'high',
    short: 'This code has been blocked and cannot be counted',
    action: 'Decide what the code means, then unblock it.',
    blocks: true,
    remedy: 'items.blocked set to false, once the code means one thing',
  },
  AMBIGUOUS_ITEM_IDENTITY: {
    code: 'AMBIGUOUS_ITEM_IDENTITY',
    severity: 'high',
    short: 'This code or barcode matches more than one item',
    action: 'Separate the items or retire one of the codes before counting.',
    blocks: true,
    remedy: 'the shared label removed from all but one item',
  },
  ITEM_INACTIVE: {
    code: 'ITEM_INACTIVE',
    severity: 'low',
    short: 'Item is retired but still holds stock',
    action: 'Either reactivate it or write the remaining stock off.',
    blocks: false,
    remedy: 'the item reactivated, or the remaining stock written off',
  },

  // --- units ---------------------------------------------------------------
  BOOK_UNIT_MISMATCH: {
    code: 'BOOK_UNIT_MISMATCH',
    severity: 'high',
    short: 'The book figure is in a different unit from the item',
    action: 'Set a conversion, or correct the unit at the source.',
    blocks: true,
    remedy: 'a book snapshot in the item stock unit, or a stored conversion',
  },
  COUNT_UNIT_MISMATCH: {
    code: 'COUNT_UNIT_MISMATCH',
    severity: 'high',
    short: 'The count was recorded in a different unit from the item',
    action: 'Recount in the item unit, or set a conversion.',
    blocks: true,
    remedy: 'a count line in the item stock unit, or a stored conversion',
  },
  MOVEMENT_UNIT_MISMATCH: {
    code: 'MOVEMENT_UNIT_MISMATCH',
    severity: 'high',
    short: 'Some movements are in a different unit from the item',
    action: 'Set a conversion, or correct the unit at the source.',
    blocks: true,
    remedy: 'the offending movements restated in the item stock unit',
  },

  // --- absence -------------------------------------------------------------
  NEVER_COUNTED: {
    code: 'NEVER_COUNTED',
    severity: 'medium',
    short: 'This item has never been physically counted',
    action: 'Count it to establish a figure that is worth trusting.',
    blocks: true,
    remedy: 'one count line for this item and location',
  },
  NO_BOOK_POSITION: {
    code: 'NO_BOOK_POSITION',
    severity: 'low',
    short: 'No book figure has been imported for this item',
    action: 'Import a book position if you want the count checked against one.',
    blocks: false,
    remedy: 'a book snapshot for this item and location',
  },
  MISSING_LOCATION: {
    code: 'MISSING_LOCATION',
    severity: 'low',
    short: 'Counted without a location',
    action: 'Record where it was found so it can be found again.',
    blocks: false,
    remedy: 'a count line carrying a location',
  },

  // --- age -----------------------------------------------------------------
  COUNT_STALE: {
    code: 'COUNT_STALE',
    severity: 'medium',
    short: 'The last count is older than your policy allows',
    action: 'Recount to bring it back into date.',
    blocks: false,
    remedy: 'a count line dated within the stale window',
  },
  BOOK_STALE: {
    code: 'BOOK_STALE',
    severity: 'low',
    short: 'The book figure predates the count by longer than policy allows',
    action: 'Import a newer book position before comparing the two.',
    blocks: false,
    remedy: 'a book snapshot dated within bookStaleAfterDays of the count',
  },
  BOOK_UNDATED: {
    code: 'BOOK_UNDATED',
    severity: 'medium',
    short: 'The book figure carries no date, so it cannot be placed in time',
    action: 'Supply an as-at date with the import.',
    blocks: false,
    remedy: 'the same book snapshot with as_of populated',
  },

  // --- movement completeness ----------------------------------------------
  UNMATCHED_MOVEMENTS_AT_SITE: {
    code: 'UNMATCHED_MOVEMENTS_AT_SITE',
    severity: 'medium',
    short: 'Some movements at this site are not linked to any item',
    action: 'Link them so every position can be relied on.',
    blocks: false,
    remedy: 'every movement at the site attached to an item',
  },
  MOVEMENT_MAY_BELONG_HERE: {
    code: 'MOVEMENT_MAY_BELONG_HERE',
    severity: 'high',
    short: 'An unmatched movement carries a code close to this item',
    action: 'Confirm whether it belongs to this item. Until then the figure would be a guess.',
    blocks: true,
    remedy: 'the unmatched movement attached to an item, whichever item that turns out to be',
  },
  MOVEMENT_UNDATED: {
    code: 'MOVEMENT_UNDATED',
    severity: 'high',
    short: 'A movement has no date, so it cannot be placed before or after the count',
    action: 'Supply movement dates at the source.',
    blocks: true,
    remedy: 'occurred_at populated on the movements listed in the evidence',
  },
  MOVEMENT_SPANS_COUNT: {
    code: 'MOVEMENT_SPANS_COUNT',
    severity: 'high',
    short: 'A movement happened before the count but was recorded after it',
    action:
      'Confirm whether those goods were on the shelf when it was counted. Until then the figure would be a guess.',
    blocks: true,
    remedy:
      'a human ruling on whether those goods were present at the count, recorded as a correcting movement or a fresh count',
  },
  MOVEMENT_DURING_OPEN_COUNT: {
    code: 'MOVEMENT_DURING_OPEN_COUNT',
    severity: 'medium',
    short: 'Stock moved while the count session was open',
    action: 'Check whether the counter saw these goods before or after they moved.',
    blocks: false,
    remedy: 'confirmation of whether the counter saw the goods before or after they moved',
  },
  SUSPECTED_DUPLICATE_MOVEMENT: {
    code: 'SUSPECTED_DUPLICATE_MOVEMENT',
    severity: 'medium',
    short: 'Two identical movements arrived close together',
    action: 'Confirm whether that was one delivery or two.',
    blocks: false,
    remedy: 'one of the pair voided, or both confirmed genuine',
  },

  // --- source health -------------------------------------------------------
  SOURCE_FEED_STALE: {
    code: 'SOURCE_FEED_STALE',
    severity: 'medium',
    short: 'A source has not delivered anything for longer than expected',
    action: 'Check the connection. Recent movements may be missing.',
    blocks: false,
    remedy: 'a successful sync from the source',
  },

  // --- contradiction -------------------------------------------------------
  NEGATIVE_DERIVED_POSITION: {
    code: 'NEGATIVE_DERIVED_POSITION',
    severity: 'high',
    short: 'Applying the movements gives less than nothing',
    action: 'Something is missing or doubled. Check receipts and issues since the count.',
    blocks: true,
    remedy: 'the missing receipt supplied, or the doubled issue voided',
  },
  CLOCK_SKEW: {
    code: 'CLOCK_SKEW',
    severity: 'medium',
    short: "The counting device's clock disagreed with the server",
    action: 'Check the device time. The count time may be wrong.',
    blocks: false,
    remedy: 'a count from a device whose clock agrees with the server',
  },
  COUNT_AFTER_EVALUATION: {
    code: 'COUNT_AFTER_EVALUATION',
    severity: 'high',
    short: 'The count is dated in the future',
    action: 'Correct the device clock and recount.',
    blocks: true,
    remedy: 'a count line dated in the past',
  },
} as const satisfies Record<string, ReasonDefinition>;

export type ReasonCode = keyof typeof REASONS;

export function reason(code: ReasonCode): ReasonDefinition {
  return REASONS[code];
}

/** Highest severity across a set of reasons, for ordering a work queue. */
export function worstSeverity(codes: string[]): 'high' | 'medium' | 'low' | null {
  let worst: 'high' | 'medium' | 'low' | null = null;
  for (const c of codes) {
    const def = (REASONS as Record<string, ReasonDefinition>)[c];
    if (!def) continue;
    if (def.severity === 'high') return 'high';
    if (def.severity === 'medium') worst = 'medium';
    else if (worst === null) worst = 'low';
  }
  return worst;
}
