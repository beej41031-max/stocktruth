/**
 * @stocktruth/engine
 *
 * Decides what can honestly be said about a stock position, given evidence.
 *
 * Has no database, no network, no clock of its own and no knowledge of any
 * particular company's schema. Feed it evidence through the shapes in ports.ts
 * and it returns a state, a quantity or an explicit refusal, the reasons, and
 * pointers back to the rows it used.
 *
 * The one rule: never turn incomplete evidence into false certainty.
 */

export { reconcile, ENGINE_VERSION } from './reconcile';
export { explain, type Explanation, type Blocker } from './explain';
export { asOfKnowledge, type KnowledgeQuery } from './asof';
export { REASONS, reason, worstSeverity, type ReasonCode, type ReasonDefinition } from './reasons';
export {
  DEFAULT_POLICY,
  MOVEMENT_SIGN,
  type BookSnapshot,
  type CountLine,
  type ItemRef,
  type Movement,
  type MovementType,
  type Quantity,
  type ReconciliationInput,
  type ReconciliationOutput,
  type ReconciliationPolicy,
  type ReconciliationState,
  type SourceHealth,
} from './types';
export type { EvidenceSource, ScopeEvidence, ScopeRef, SiteRef } from './ports';

export {
  findSuspectedDuplicateMovementGroups,
  removeReversalPairs,
  DEFAULT_DUPLICATE_WINDOW_MS,
  type SuspectedDuplicateMovementGroup,
  type ReversalPairResult,
} from './movement-evidence';

export { analyseMaterialVariance, scoreVerificationCandidate, compareVerificationCandidates, type MaterialVarianceInput, type EvidenceKnowledgePolicy, type MaterialVarianceOutput, type MaterialVarianceState, type MaterialVarianceReason, type PhysicalObservation, type ProductionOutput, type BomLine, type BomVersion, type VerificationCandidateInput, type VerificationCandidate } from './variance';
export { assessOperationalPosition, type OperationalPositionInput, type OperationalPosition, type OperationalDecision, type DecisionAdvice, type DecisionDisposition } from './operational';

export {
  combineEvidenceClosure,
  combineHistoricalEvidenceClosure,
  firstWatermarkClaimThrough,
  type EvidenceClosureInput,
  type EvidenceClosure,
  type WatermarkClaim,
  type AutomatedSourceHistory,
  type AutomatedEvidenceReview,
  type HistoricalEvidenceClosureInput,
  type HistoricalEvidenceClosure,
} from './closure';
