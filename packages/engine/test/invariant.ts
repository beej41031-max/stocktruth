import { explain } from '../src/explain';
import type { ReconciliationInput } from '../src/types';

/**
 * The one property that must hold for every scope, at any scale.
 *
 * The 53 unit tests check specific hand-built cases. This checks the actual
 * rule — refused iff blocking reason present, and a stated quantity is always
 * finite — against whatever the stress generator throws at it, which is not
 * hand-picked and is not polite.
 */
export function checkInvariant(input: ReconciliationInput): string | null {
  const e = explain(input);
  if (e.refused && e.derivedQuantity != null) {
    return 'refused but a quantity was still returned';
  }
  if (!e.refused && e.derivedQuantity == null) {
    return 'stated no position but declared no blocker';
  }
  if (e.derivedQuantity != null && !Number.isFinite(e.derivedQuantity)) {
    return `stated a non-finite quantity: ${e.derivedQuantity}`;
  }
  if (e.refused !== e.blockers.length > 0) {
    return 'refused flag disagrees with blocker count';
  }
  return null;
}
