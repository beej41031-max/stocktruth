/**
 * Combine independent evidence-completeness claims without allowing a manual
 * assertion to override an automated source that has not caught up.
 */
export interface EvidenceClosureInput {
  hasAutomated: boolean;
  hasManual: boolean;
  automatedWatermark: Date | null;
  automatedClaimedAt: Date | null;
  manualThrough: Date | null;
  manualClaimedAt: Date | null;
}

export interface EvidenceClosure {
  watermark: Date | null;
  observedAt: Date | null;
}

/** One immutable claim made by an automated source. */
export interface WatermarkClaim {
  watermarkAt: Date;
  claimedAt: Date;
}

export interface AutomatedSourceHistory {
  sourceSystemId: string;
  claims: readonly WatermarkClaim[];
}

/** Owner/manager acknowledgement of late evidence for one historical close. */
export interface AutomatedEvidenceReview {
  sourceSystemId: string;
  /** Latest StockTruth import time explicitly reviewed. Future arrivals reopen. */
  reviewedThroughImportedAt: Date;
  /** When the owner/manager made the acknowledgement. */
  reviewedAt: Date;
}

export interface HistoricalEvidenceClosureInput {
  /** Physical/event-time cutoff the interval needs every required source to cover. */
  cutoff: Date;
  automatedSources: readonly AutomatedSourceHistory[];
  /** True when at least one manual/null source contributes evidence. */
  hasManual: boolean;
  manualThrough: Date | null;
  manualClaimedAt: Date | null;
  /** Append-only reviews that re-close a source after late evidence was inspected. */
  automatedReviews?: readonly AutomatedEvidenceReview[];
}

export interface HistoricalEvidenceClosure extends EvidenceClosure {
  /** First immutable completeness claim that crossed this cutoff, by source. */
  automatedClaimedAtBySource: Readonly<Record<string, Date | null>>;
  /** Arrival-time cutoff currently accepted for each source after any reviews. */
  automatedKnowledgeCutoffBySource: Readonly<Record<string, Date | null>>;
}

/**
 * Return the first claim, in knowledge time, that said the source was complete
 * through the requested event-time cutoff. Later watermark advances must never
 * replace this when evaluating an older interval: doing so would allow a late
 * row to become "not late" merely because another sync happened afterwards.
 */
export function firstWatermarkClaimThrough(
  claims: readonly WatermarkClaim[],
  cutoff: Date,
): WatermarkClaim | null {
  let first: WatermarkClaim | null = null;
  for (const claim of claims) {
    if (claim.watermarkAt.getTime() < cutoff.getTime()) continue;
    if (first == null || claim.claimedAt.getTime() < first.claimedAt.getTime()) {
      first = claim;
    }
  }
  return first;
}

/**
 * Historical closure for an interval. Every automated source must have made a
 * claim that crossed the cutoff. Manual evidence is required when a manual
 * source exists, or when there are no automated sources at all.
 */
export function combineHistoricalEvidenceClosure(
  input: HistoricalEvidenceClosureInput,
): HistoricalEvidenceClosure {
  const manualRequired = input.hasManual || input.automatedSources.length === 0;
  const through: Date[] = [];
  const claims: Date[] = [];
  const bySource: Record<string, Date | null> = {};
  const knowledgeBySource: Record<string, Date | null> = {};

  for (const source of input.automatedSources) {
    const first = firstWatermarkClaimThrough(source.claims, input.cutoff);
    bySource[source.sourceSystemId] = first?.claimedAt ?? null;
    knowledgeBySource[source.sourceSystemId] = first?.claimedAt ?? null;
    if (!first) {
      return {
        watermark: null, observedAt: null,
        automatedClaimedAtBySource: bySource,
        automatedKnowledgeCutoffBySource: knowledgeBySource,
      };
    }

    const reviews = (input.automatedReviews ?? [])
      .filter((r) => r.sourceSystemId === source.sourceSystemId)
      .sort((a, b) => b.reviewedThroughImportedAt.getTime() - a.reviewedThroughImportedAt.getTime());
    const latestReview = reviews[0] ?? null;

    through.push(first.watermarkAt);
    if (latestReview) {
      knowledgeBySource[source.sourceSystemId] =
        latestReview.reviewedThroughImportedAt.getTime() > first.claimedAt.getTime()
          ? latestReview.reviewedThroughImportedAt
          : first.claimedAt;
      claims.push(
        latestReview.reviewedAt.getTime() > first.claimedAt.getTime()
          ? latestReview.reviewedAt
          : first.claimedAt,
      );
    } else {
      claims.push(first.claimedAt);
    }
  }

  if (manualRequired) {
    if (
      !input.manualThrough ||
      !input.manualClaimedAt ||
      input.manualThrough.getTime() < input.cutoff.getTime()
    ) {
      return {
        watermark: null, observedAt: null,
        automatedClaimedAtBySource: bySource,
        automatedKnowledgeCutoffBySource: knowledgeBySource,
      };
    }
    through.push(input.manualThrough);
    claims.push(input.manualClaimedAt);
  }

  if (through.length === 0 || claims.length === 0) {
    return {
      watermark: null, observedAt: null,
      automatedClaimedAtBySource: bySource,
      automatedKnowledgeCutoffBySource: knowledgeBySource,
    };
  }

  return {
    watermark: new Date(Math.min(...through.map((d) => d.getTime()))),
    observedAt: new Date(Math.max(...claims.map((d) => d.getTime()))),
    automatedClaimedAtBySource: bySource,
    automatedKnowledgeCutoffBySource: knowledgeBySource,
  };
}

export function combineEvidenceClosure(input: EvidenceClosureInput): EvidenceClosure {
  // No automated source means the stream is manual by default. This lets an
  // office assert a true zero-activity period instead of treating no rows as
  // evidence that nothing happened.
  const manualRequired = input.hasManual || !input.hasAutomated;
  const through: Date[] = [];
  const claims: Date[] = [];

  if (input.hasAutomated) {
    if (!input.automatedWatermark || !input.automatedClaimedAt) {
      return { watermark: null, observedAt: null };
    }
    through.push(input.automatedWatermark);
    claims.push(input.automatedClaimedAt);
  }

  if (manualRequired) {
    if (!input.manualThrough || !input.manualClaimedAt) {
      return { watermark: null, observedAt: null };
    }
    through.push(input.manualThrough);
    claims.push(input.manualClaimedAt);
  }

  return {
    // Earliest required event-time cutoff wins. A human cannot tick past an
    // automated connector whose own watermark is still behind.
    watermark: new Date(Math.min(...through.map((d) => d.getTime()))),
    // The combined assertion did not exist until the last required party/source
    // made its claim. Evidence arriving after this time reopens the interval.
    observedAt: new Date(Math.max(...claims.map((d) => d.getTime()))),
  };
}
