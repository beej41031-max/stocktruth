import { REASONS, type ReasonDefinition } from './reasons';
import { reconcile } from './reconcile';
import type { ReconciliationInput, ReconciliationOutput } from './types';

/**
 * Why a number is refused, and what would bring it back.
 *
 * This exists because "cannot be stated" is only worth anything if it is
 * derivable rather than asserted. If a refusal is a pile of hand-written
 * warnings wrapped around a fuzzy calculation, then somebody six months from
 * now will read the calculation, decide the warnings are noise, and wrap the
 * whole thing in a coalesce.
 *
 * So the refusal is defined exactly:
 *
 *   a position is refused if and only if at least one reason with
 *   blocks: true is present
 *
 * and this function proves it by re-running the engine with each blocking
 * reason's evidence removed, one at a time, and reporting what changes. If
 * removing every blocker does not produce a number, the definition is wrong
 * and the test suite says so rather than the docs claiming otherwise.
 */

export interface Blocker {
  code: string;
  short: string;
  /** The general shape of what would clear this class of blocker. */
  remedy: string;
  /**
   * What would clear *this* blocker, naming the actual records involved.
   *
   * The difference matters. "A movement happened before the count but was
   * recorded after it" tells somebody there is a problem. "Receipt R184 of
   * 8,400 may or may not have been included in count C92, taken an hour later
   * — confirm whether those goods were on the shelf, or count it again"
   * tells them what to go and do, to whom, about what.
   */
  resolution: string;
  /** The rows this blocker was drawn from, so it can be checked by hand. */
  evidence: string[];
}

export interface Explanation {
  state: ReconciliationOutput['state'];
  /** Null when the engine will not commit to a position. */
  derivedQuantity: number | null;
  /** True when a position is refused. Equal to blockers.length > 0, always. */
  refused: boolean;
  blockers: Blocker[];
  /** Reasons present that weaken the answer without withdrawing it. */
  caveats: { code: string; short: string; remedy: string }[];
  /**
   * What the position would be if every blocker were cleared and nothing else
   * changed. Offered as arithmetic, clearly labelled, never stored and never
   * shown as the answer. It is the thing somebody wants to know when deciding
   * whether chasing the missing evidence is worth the trouble.
   */
  ifCleared: {
    quantity: number | null;
    assuming: string[];
  } | null;
}

function definition(code: string): ReasonDefinition | undefined {
  return (REASONS as Record<string, ReasonDefinition>)[code];
}

export function explain(input: ReconciliationInput): Explanation {
  const result = reconcile(input);

  const blockers: Blocker[] = [];
  const caveats: Explanation['caveats'] = [];

  for (const code of result.reasons) {
    const def = definition(code);
    if (!def) continue;
    if (def.blocks) {
      blockers.push({
        code,
        short: def.short,
        remedy: def.remedy,
        resolution: resolutionFor(code, input, result),
        evidence: evidenceFor(code, input, result),
      });
    } else {
      caveats.push({ code, short: def.short, remedy: def.remedy });
    }
  }

  const refused = result.derivedQuantity == null;

  // The definition has to hold both ways round. If these ever disagree the
  // engine is refusing for a reason it has not declared, which is exactly the
  // failure this function exists to make impossible to ship.
  if (refused !== (blockers.length > 0)) {
    throw new Error(
      `Engine refused a position without a blocking reason, or declared a blocker ` +
        `while still stating one. State ${result.state}, reasons ${result.reasons.join(', ')}. ` +
        `This is a bug in the rules, not in the data.`,
    );
  }

  return {
    state: result.state,
    derivedQuantity: result.derivedQuantity,
    refused,
    blockers,
    caveats,
    ifCleared: refused ? hypothetical(input, blockers) : null,
  };
}

/**
 * The arithmetic if every blocker were resolved the most favourable way.
 *
 * Deliberately returns its assumptions alongside the number, because the
 * number is worthless without them. A caller that shows the quantity and drops
 * the assumptions has reintroduced the exact problem this product exists to
 * prevent, and there is no way to stop them beyond making it awkward.
 */
function hypothetical(
  input: ReconciliationInput,
  blockers: Blocker[],
): Explanation['ifCleared'] {
  const { count, movements } = input;
  if (!count) {
    return {
      quantity: null,
      assuming: ['somebody counts it, since nothing can be derived until then'],
    };
  }

  const assuming: string[] = [];
  const codes = new Set(blockers.map((b) => b.code));

  // Movements that were set aside, put back on the most favourable reading.
  let net = 0;
  for (const m of movements) {
    if (m.occurredAt == null) {
      if (codes.has('MOVEMENT_UNDATED')) {
        assuming.push(`movement ${ref('M', m.id)} is dated after the count`);
        net += signOf(m.type) * m.quantity;
      }
      continue;
    }
    const after = m.occurredAt.getTime() > count.countedAt.getTime();
    const spans =
      m.occurredAt.getTime() <= count.countedAt.getTime() &&
      m.recordedAt != null &&
      m.recordedAt.getTime() > count.countedAt.getTime();

    if (spans && codes.has('MOVEMENT_SPANS_COUNT')) {
      assuming.push(
        `the ${m.quantity} from movement ${ref('M', m.id)} was already on the shelf when counted`,
      );
      continue; // already inside the counted figure on this reading
    }
    if (after) net += signOf(m.type) * m.quantity;
  }

  if (codes.has('MOVEMENT_MAY_BELONG_HERE')) {
    assuming.push('the unmatched movements turn out to belong to another item');
  }
  if (codes.has('AMBIGUOUS_ITEM_IDENTITY') || codes.has('ITEM_BLOCKED')) {
    return { quantity: null, assuming: ['the identity is settled first, since nothing follows until it is'] };
  }

  return { quantity: count.quantity + net, assuming };
}

function signOf(type: string): 1 | -1 {
  return type === 'ISSUE' || type === 'TRANSFER_OUT' || type === 'WASTE' ? -1 : 1;
}

/** The specific rows a blocker was drawn from. */
function evidenceFor(
  code: string,
  input: ReconciliationInput,
  result: ReconciliationOutput,
): string[] {
  const { book, count, movements } = input;

  switch (code) {
    case 'ITEM_BLOCKED':
      return [`item ${input.item.id}: ${input.item.blockedReason ?? 'blocked'}`];
    case 'AMBIGUOUS_ITEM_IDENTITY':
      return [`item ${input.item.id} shares a label with at least one other item`];
    case 'NEVER_COUNTED':
      return ['no count line for this item and location'];
    case 'BOOK_UNIT_MISMATCH':
      return book ? [`book ${book.id} is in ${book.unit}, item is held in ${input.item.stockUnit}`] : [];
    case 'COUNT_UNIT_MISMATCH':
      return count ? [`count ${count.id} is in ${count.unit}, item is held in ${input.item.stockUnit}`] : [];
    case 'MOVEMENT_UNIT_MISMATCH':
      return movements.filter((m) => m.unit !== input.item.stockUnit).map((m) => `movement ${m.id} is in ${m.unit}`);
    case 'MOVEMENT_UNDATED':
      return movements.filter((m) => m.occurredAt == null).map((m) => `movement ${m.id} has no occurred_at`);
    case 'MOVEMENT_SPANS_COUNT':
      return count
        ? movements
            .filter(
              (m) =>
                m.occurredAt != null &&
                m.recordedAt != null &&
                m.occurredAt.getTime() <= count.countedAt.getTime() &&
                m.recordedAt.getTime() > count.countedAt.getTime(),
            )
            .map(
              (m) =>
                `movement ${m.id}: ${m.quantity} occurred ${m.occurredAt!.toISOString()}, ` +
                `recorded ${m.recordedAt!.toISOString()}, count was ${count.countedAt.toISOString()}`,
            )
        : [];
    case 'MOVEMENT_MAY_BELONG_HERE':
      return [`${input.possiblyRelatedUnlinkedCount} unmatched movement(s) carry a code this item answers to`];
    case 'NEGATIVE_DERIVED_POSITION':
      return [`counted ${count?.quantity} then ${result.movementNet} net, which is below zero`];
    case 'COUNT_AFTER_EVALUATION':
      return count ? [`count ${count.id} is dated ${count.countedAt.toISOString()}`] : [];
    default:
      return [];
  }
}

/** A short, stable label for a record, so instructions can name things. */
function ref(prefix: string, id: string): string {
  // Ids are uuids in this host and something else in the next one. The last
  // segment is short enough to say out loud and long enough to be unambiguous
  // within one item's history, which is the only place it is ever used.
  const tail = id.includes('-') ? id.split('-').pop()! : id;
  return `${prefix}${tail.slice(-6).toUpperCase()}`;
}

/**
 * What to do about this specific blocker, naming the specific records.
 *
 * Written as an instruction to a person, in their terms. Somebody reading this
 * should be able to walk away and do it without opening the database.
 */
function resolutionFor(
  code: string,
  input: ReconciliationInput,
  result: ReconciliationOutput,
): string {
  const { item, book, count, movements } = input;
  const unit = item.stockUnit;

  switch (code) {
    case 'ITEM_BLOCKED':
      return (
        `${item.sku ?? item.name} is blocked: ${item.blockedReason ?? 'no reason recorded'}. ` +
        `Decide what the code means, split it if it covers two things, then unblock it.`
      );

    case 'AMBIGUOUS_ITEM_IDENTITY':
      return (
        `${item.sku ?? item.name} shares a code or barcode with at least one other item, so a ` +
        `scan cannot tell them apart. Retire the duplicate label from all but one item.`
      );

    case 'NEVER_COUNTED':
      return `Nobody has counted ${item.sku ?? item.name}. Count it once and a position follows.`;

    case 'BOOK_UNIT_MISMATCH':
      return (
        `The book figure for ${item.sku ?? item.name} is ${book?.quantity} ${book?.unit}, but the ` +
        `item is held in ${unit}. Either correct the unit at the source or record a conversion. ` +
        `Nothing is assumed, because guessing that a case is twenty-four is how a wrong number ` +
        `gets an authoritative-looking source.`
      );

    case 'COUNT_UNIT_MISMATCH':
      return (
        `Count ${count ? ref('C', count.id) : ''} was recorded in ${count?.unit}, but ` +
        `${item.sku ?? item.name} is held in ${unit}. Recount in ${unit}, or record a conversion.`
      );

    case 'MOVEMENT_UNIT_MISMATCH': {
      const bad = movements.filter((m) => m.unit !== unit);
      return (
        `${bad.length === 1 ? 'Movement' : 'Movements'} ` +
        `${bad.map((m) => ref('M', m.id)).join(', ')} ` +
        `${bad.length === 1 ? 'is' : 'are'} recorded in ` +
        `${[...new Set(bad.map((m) => m.unit))].join(', ')}, but ${item.sku ?? item.name} is held ` +
        `in ${unit}. Restate them at the source, or record a conversion.`
      );
    }

    case 'MOVEMENT_UNDATED': {
      const undated = movements.filter((m) => m.occurredAt == null);
      return (
        `${undated.map((m) => `${ref('M', m.id)} (${m.quantity} ${m.unit})`).join(', ')} ` +
        `${undated.length === 1 ? 'has' : 'have'} no date, so ` +
        `${undated.length === 1 ? 'it cannot' : 'they cannot'} be placed before or after the ` +
        `count. Supply the date at the source.`
      );
    }

    case 'MOVEMENT_SPANS_COUNT': {
      if (!count) return 'A movement cannot be placed relative to the count.';
      const spanning = movements.filter(
        (m) =>
          m.occurredAt != null &&
          m.recordedAt != null &&
          m.occurredAt.getTime() <= count.countedAt.getTime() &&
          m.recordedAt.getTime() > count.countedAt.getTime(),
      );
      const parts = spanning.map((m) => {
        const gapMin = Math.round(
          (m.recordedAt!.getTime() - m.occurredAt!.getTime()) / 60_000,
        );
        const gap = gapMin >= 120 ? `${Math.round(gapMin / 60)} hours` : `${gapMin} minutes`;
        return (
          `${ref('M', m.id)}, ${m.quantity} ${m.unit}, arrived ${m.occurredAt!.toISOString()} ` +
          `but was not recorded until ${gap} later`
        );
      });
      return (
        `${parts.join('; ')}. Count ${ref('C', count.id)} was taken at ` +
        `${count.countedAt.toISOString()}, in between. So ` +
        `${spanning.length === 1 ? 'that delivery' : 'those deliveries'} may or may not have been ` +
        `on the shelf when the counter looked, and applying ` +
        `${spanning.length === 1 ? 'it' : 'them'} would double-count while ignoring ` +
        `${spanning.length === 1 ? 'it' : 'them'} would undercount. ` +
        `Ask whoever received the delivery or whoever counted, and record the answer as a ` +
        `correcting movement. Or count ${item.sku ?? item.name} again now, which settles it ` +
        `without anyone having to remember.`
      );
    }

    case 'MOVEMENT_MAY_BELONG_HERE':
      return (
        `${input.possiblyRelatedUnlinkedCount} unmatched ` +
        `${input.possiblyRelatedUnlinkedCount === 1 ? 'movement carries' : 'movements carry'} a ` +
        `code that ${item.sku ?? item.name} answers to. Attach ` +
        `${input.possiblyRelatedUnlinkedCount === 1 ? 'it' : 'them'} to whichever item ` +
        `${input.possiblyRelatedUnlinkedCount === 1 ? 'it belongs' : 'they belong'} to. Until ` +
        `then this item's position depends on a question nobody has answered.`
      );

    case 'NEGATIVE_DERIVED_POSITION':
      return (
        `Counted ${count?.quantity} ${unit}, then ${result.movementNet} net since, which is less ` +
        `than nothing. Either a receipt is missing or an issue has been recorded twice. Check ` +
        `what has moved since ${count?.countedAt.toISOString()}.`
      );

    case 'COUNT_AFTER_EVALUATION':
      return (
        `Count ${count ? ref('C', count.id) : ''} is dated ${count?.countedAt.toISOString()}, ` +
        `which is in the future. The counting device's clock is wrong. Fix it and count again.`
      );

    default:
      return (REASONS as Record<string, ReasonDefinition>)[code]?.action ?? code;
  }
}
