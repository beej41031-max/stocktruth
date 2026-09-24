# ADR 0020 — evidence closure is a separate office assertion

Accepted in v0.4.2. This supersedes the v0.4.1 wording in ADR 0018 that allowed evidence completeness to be attested while closing a count session.

## Context

A physical counter can say what was on the shelf at a particular time. They usually cannot know whether every receipt, transfer, return or production record has reached the system yet. Treating the counter's **Complete** button as evidence completeness turns a safety control into a habitual bypass.

Automated sources create a second trap. A manual assertion must never advance a connector whose own event-time watermark is still behind.

## Decision

1. **Physical closure and evidence closure are different events.** Closing a count session freezes the physical observation cutoff only. It does not certify movements or production evidence.
2. **Manual closure is a later office/owner assertion.** An owner or manager may attest that manual movement and/or production records are complete **through the physical closing-count time**. The system separately records when that assertion was made.
3. **Automated sources settle themselves.** Manual attestation can satisfy only the manual part of a stream. If automated and manual evidence both exist, every required side must close and the effective event-time watermark is the earliest required cutoff.
4. **Knowledge time is first-class.** Automated watermarks carry `event_watermark_updated_at`; manual attestations carry `*_confirmed_at`. Evidence learned after the completeness assertion reopens the affected interval.
5. **A closed count session is immutable as a physical session.** New count lines require a new session so the certified physical cutoff cannot move later.
6. **Ambiguous reversal graphs refuse closure.** A reversal chain is evaluated by parity; reversal-of-reversal reinstates the original. Branches, orphans, malformed edges and cycles are invalid evidence rather than arithmetic inputs.

## Consequences

Manual spreadsheet businesses can still reach `CLOSED`, but only after somebody responsible for the paperwork explicitly certifies the cutoff. A human cannot leapfrog a lagging connector. Late-arriving evidence can make a previously closed interval provisional again; this is expected and is safer than preserving a stale claim of certainty.
