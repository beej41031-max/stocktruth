import { MOVEMENT_SIGN, type Movement } from './types';

export interface ReversalPairResult {
  effective: Movement[];
  removedIds: string[];
  orphanReversalIds: string[];
  invalidReversalIds: string[];
}

export interface SuspectedDuplicateMovementGroup {
  movementIds: string[];
  movements: Array<Movement & { occurredAt: Date }>;
}

export const DEFAULT_DUPLICATE_WINDOW_MS = 5 * 60_000;

/**
 * Find movements that are indistinguishable enough to be plausible duplicate
 * postings rather than independent physical events.
 *
 * This function deliberately does not merge or discard anything. A false
 * positive is safer than silently deleting a genuine second delivery, so the
 * caller must treat the group as unresolved evidence and either refuse exact
 * arithmetic or ask a human/source system to resolve it.
 *
 * Callers should pass reversal-normalised movements. Valid reversal pairs are
 * corrections, not duplicate candidates; invalid reversal structures are a
 * separate evidence problem and should already be blocking.
 *
 * Groups are built by exact type + unit + quantity and event-time proximity.
 * Source system is intentionally not part of the signature: the same physical
 * receipt can be duplicated across integrations as well as inside one feed.
 * Zero-quantity rows are ignored because duplicating a no-op cannot change a
 * stock position or a material-variance result.
 */
export function findSuspectedDuplicateMovementGroups(
  movements: Movement[],
  windowMs = DEFAULT_DUPLICATE_WINDOW_MS,
): SuspectedDuplicateMovementGroup[] {
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new Error('duplicate window must be a finite non-negative number');
  }

  const byShape = new Map<string, Array<Movement & { occurredAt: Date }>>();

  for (const movement of movements) {
    if (movement.occurredAt == null) continue;
    if (!Number.isFinite(movement.quantity) || movement.quantity <= 0) continue;

    const key = [movement.type, movement.unit, String(movement.quantity)].join('\u0000');
    const list = byShape.get(key) ?? [];
    list.push(movement as Movement & { occurredAt: Date });
    byShape.set(key, list);
  }

  const groups: SuspectedDuplicateMovementGroup[] = [];

  for (const candidates of byShape.values()) {
    const sorted = [...candidates].sort((a, b) => {
      const time = a.occurredAt.getTime() - b.occurredAt.getTime();
      return time !== 0 ? time : a.id.localeCompare(b.id);
    });

    let cluster: Array<Movement & { occurredAt: Date }> = [];

    const flush = () => {
      if (cluster.length > 1) {
        groups.push({
          movementIds: cluster.map((movement) => movement.id),
          movements: [...cluster],
        });
      }
      cluster = [];
    };

    for (const movement of sorted) {
      if (cluster.length === 0) {
        cluster.push(movement);
        continue;
      }

      const previous = cluster[cluster.length - 1]!;
      const delta = movement.occurredAt.getTime() - previous.occurredAt.getTime();
      if (delta <= windowMs) {
        cluster.push(movement);
      } else {
        flush();
        cluster.push(movement);
      }
    }

    flush();
  }

  return groups.sort((a, b) => {
    const time = a.movements[0]!.occurredAt.getTime() - b.movements[0]!.occurredAt.getTime();
    return time !== 0 ? time : a.movementIds[0]!.localeCompare(b.movementIds[0]!);
  });
}

/**
 * Reversals are corrections, not new physical flow.
 *
 * Valid reversal chains are evaluated by parity, from the tail back toward the
 * original. That means:
 *
 *   A                 -> A stands
 *   A <- B            -> A and B cancel
 *   A <- B <- C       -> B and C cancel, A stands
 *   A <- B <- C <- D  -> C/D cancel, then A/B cancel
 *
 * This is important because reversing a reversal reinstates the original
 * movement. A branch (two rows reversing the same original), a malformed edge,
 * an orphan or a cycle is ledger ambiguity, not something to normalise away.
 */
export function removeReversalPairs(movements: Movement[]): ReversalPairResult {
  const byId = new Map(movements.map((m) => [m.id, m]));
  const children = new Map<string, Movement[]>();
  const orphanReversalIds: string[] = [];
  const invalid = new Set<string>();

  for (const movement of movements) {
    if (!movement.reversalOfId) continue;
    const original = byId.get(movement.reversalOfId);
    if (!original) {
      orphanReversalIds.push(movement.id);
      continue;
    }
    const list = children.get(original.id) ?? [];
    list.push(movement);
    children.set(original.id, list);
  }

  // A movement may be reversed at most once. Two corrections against the same
  // original are contradictory even if their net physical effect happens to be
  // zero, because there is no defensible chain ordering.
  for (const [originalId, reversers] of children) {
    if (reversers.length > 1) {
      invalid.add(originalId);
      for (const r of reversers) invalid.add(r.id);
    }
  }

  // Every reversal edge must genuinely cancel its immediate original.
  for (const movement of movements) {
    if (!movement.reversalOfId) continue;
    const original = byId.get(movement.reversalOfId);
    if (!original) continue;
    const cancels =
      original.unit === movement.unit &&
      original.quantity === movement.quantity &&
      MOVEMENT_SIGN[original.type] === -MOVEMENT_SIGN[movement.type];
    if (!cancels) {
      invalid.add(original.id);
      invalid.add(movement.id);
    }
  }

  const removed = new Set<string>();
  const visited = new Set<string>();

  const roots = movements.filter((m) => !m.reversalOfId || !byId.has(m.reversalOfId));

  for (const root of roots) {
    if (orphanReversalIds.includes(root.id)) continue;
    const chain: Movement[] = [];
    const seenInChain = new Set<string>();
    let current: Movement | undefined = root;

    while (current) {
      if (seenInChain.has(current.id)) {
        for (const id of seenInChain) invalid.add(id);
        break;
      }
      seenInChain.add(current.id);
      visited.add(current.id);
      chain.push(current);

      const next: Movement[] = children.get(current.id) ?? [];
      if (next.length > 1) break;
      current = next[0];
    }

    if (chain.some((m) => invalid.has(m.id))) continue;

    // Remove valid pairs from the tail. This preserves the original on an odd
    // chain, which correctly models reversal-of-reversal as reinstatement.
    for (let i = chain.length - 1; i > 0; i -= 2) {
      removed.add(chain[i]!.id);
      removed.add(chain[i - 1]!.id);
    }
  }

  // Any non-orphan reversal component not reached from a root is a cycle.
  for (const movement of movements) {
    if (visited.has(movement.id) || orphanReversalIds.includes(movement.id)) continue;
    if (movement.reversalOfId || children.has(movement.id)) invalid.add(movement.id);
  }

  // Never hide a row that participates in invalid reversal evidence.
  for (const id of invalid) removed.delete(id);

  return {
    effective: movements.filter((m) => !removed.has(m.id)),
    removedIds: [...removed],
    orphanReversalIds,
    invalidReversalIds: [...invalid],
  };
}
