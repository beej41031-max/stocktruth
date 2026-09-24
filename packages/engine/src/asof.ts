import { reconcile } from './reconcile';
import type { EvidenceSource, ScopeRef, SiteRef } from './ports';
import { DEFAULT_POLICY, type ReconciliationOutput } from './types';

/**
 * What the system knew at a given moment.
 *
 * Two different times are in play and conflating them is the usual way an
 * "as at" report ends up lying:
 *
 *   occurrence time - when the goods actually moved
 *   knowledge time  - when this system learned about it
 *
 * A question like "what did we think we had at 10:00 on Tuesday" is a question
 * about knowledge time. Answering it with everything the system knows today
 * produces a tidier history than the one the business actually lived through,
 * and hides exactly the late-arriving evidence that caused whatever decision
 * is now being reviewed.
 *
 * So this filters evidence by when it arrived, not by when it happened, and
 * refuses the question outright if the adapter cannot do that. A confident
 * wrong answer to a historical question is worse than no answer, because
 * nobody re-checks a number that looked fine.
 */

export interface KnowledgeQuery {
  site: SiteRef;
  scope: ScopeRef;
  /** The moment to answer as at. */
  knownAt: Date;
}

export interface KnowledgeAnswer {
  knownAt: Date;
  supported: boolean;
  reason?: string;
  result?: ReconciliationOutput;
}

export async function asOfKnowledge(
  source: EvidenceSource,
  query: KnowledgeQuery,
): Promise<KnowledgeAnswer> {
  if (!source.supportsKnownAt) {
    return {
      knownAt: query.knownAt,
      supported: false,
      reason:
        `The ${source.adapterName} adapter cannot filter evidence by when it arrived, ` +
        `so it cannot say what was known at a past moment. Answering with today's ` +
        `evidence would look like history and would not be.`,
    };
  }

  const evidence = await source.loadScope(query.site, query.scope, query.knownAt);
  if (!evidence) {
    return {
      knownAt: query.knownAt,
      supported: true,
      reason: 'Nothing was known about this item at that moment.',
    };
  }

  const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy(query.site)) };

  return {
    knownAt: query.knownAt,
    supported: true,
    result: reconcile({
      item: evidence.item,
      locationId: evidence.locationId,
      book: evidence.book,
      count: evidence.count,
      movements: evidence.movements,
      unlinkedMovementCount: evidence.unlinkedMovementCount,
      possiblyRelatedUnlinkedCount: evidence.possiblyRelatedUnlinkedCount,
      sources: evidence.sources,
      policy,
      // Judged as at that moment, not as at now. Using now would mark a count
      // that was fresh at the time as stale today.
      evaluatedAt: query.knownAt,
    }),
  };
}
