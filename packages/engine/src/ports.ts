/**
 * The seam between this engine and whatever is storing the data.
 *
 * Everything below is a plain shape. No Postgres, no Supabase, no table names,
 * no column names. That is deliberate: the interesting part of this product is
 * the reasoning about evidence, and it should be possible to point it at a
 * different company's inventory system without rewriting any of it.
 *
 * What the engine needs from a host system is small:
 *
 *   - what items exist, and what labels they answer to
 *   - what the host's own records claim the quantity is, and when
 *   - what people physically observed, and when
 *   - what moved, when it moved, and when somebody wrote it down
 *   - how healthy the feeds supplying all that are
 *
 * A host that cannot supply the last of those still works; it just gets more
 * cautious answers, which is the correct behaviour rather than a degraded one.
 *
 * The mapping from a host's tables to these shapes is an adapter. Adapters are
 * allowed to be ugly and specific. The engine is not, and nothing named after
 * a particular customer's schema belongs on this side of the line.
 */

import type {
  BookSnapshot,
  CountLine,
  ItemRef,
  Movement,
  ReconciliationPolicy,
  SourceHealth,
} from './types';

// Re-exported because it appears in EvidenceSource's own signature below.
// Anyone implementing an adapter needs it from the same place they get
// EvidenceSource, not by reaching into types.ts separately.
export type { ReconciliationPolicy };

/** Identifies one item at one location. Quantities are location-scoped. */
export interface ScopeRef {
  itemId: string;
  locationId: string | null;
}

export interface SiteRef {
  siteId: string;
}

/**
 * Everything the engine needs about one scope.
 *
 * Assembled by an adapter. The engine never asks for more than this and never
 * goes looking for it itself.
 */
export interface ScopeEvidence {
  item: ItemRef;
  locationId: string | null;
  /** Most recent book claim for this scope, if the host has one. */
  book: BookSnapshot | null;
  /** Most recent count that has not been superseded. */
  count: CountLine | null;
  /** Movements affecting this scope, any order. */
  movements: Movement[];
  /** Movements at this site the host could not attach to any item. */
  unlinkedMovementCount: number;
  /**
   * Of those, how many carry a source code that normalises to a label this
   * item answers to. An adapter that cannot work this out should return 0 and
   * accept that positions will be stated a little more freely than they
   * strictly should be.
   */
  possiblyRelatedUnlinkedCount: number;
  sources: SourceHealth[];
  /**
   * False when the host changes stock in ways this adapter cannot see, for
   * example manual adjustments that a platform's API does not expose. The
   * engine then refuses to say which side of a book-to-evidence gap is wrong.
   * Omit when the feed is complete. See decision 0025.
   */
  movementFeedComplete?: boolean;
}

/**
 * What an adapter has to provide.
 *
 * `knownAt` is the interesting parameter. It means "answer as the system would
 * have answered at this moment", which requires filtering evidence by when the
 * host learned it rather than when it happened. An adapter that cannot do that
 * should ignore the parameter and say so in its documentation, because
 * silently returning today's evidence for a historical question is worse than
 * refusing the question.
 */
export interface EvidenceSource {
  /** Every scope with evidence, plus active items with none. */
  listScopes(site: SiteRef, knownAt?: Date): Promise<ScopeRef[]>;

  /** Evidence for one scope. */
  loadScope(site: SiteRef, scope: ScopeRef, knownAt?: Date): Promise<ScopeEvidence | null>;

  /**
   * Evidence for every scope at a site, in one pass. Separate from loadScope
   * because doing it per item is the difference between a query and four
   * thousand of them, and every real adapter will want to batch.
   */
  loadSite(site: SiteRef, knownAt?: Date): Promise<ScopeEvidence[]>;

  /** Site policy. Defaults are used when a host has no opinion. */
  loadPolicy(site: SiteRef): Promise<Partial<ReconciliationPolicy>>;

  /** True when this adapter can answer historical questions honestly. */
  readonly supportsKnownAt: boolean;

  /** Shown in run records so an answer can be traced to where it came from. */
  readonly adapterName: string;
}
