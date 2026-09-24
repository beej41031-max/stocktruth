import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineEvidenceClosure, combineHistoricalEvidenceClosure, firstWatermarkClaimThrough } from '../src/closure';

const d = (s: string) => new Date(s);

test('manual-only evidence can close through the physical cutoff', () => {
  const out = combineEvidenceClosure({
    hasAutomated: false,
    hasManual: false,
    automatedWatermark: null,
    automatedClaimedAt: null,
    manualThrough: d('2026-09-15T07:00:00Z'),
    manualClaimedAt: d('2026-09-15T13:00:00Z'),
  });
  assert.equal(out.watermark?.toISOString(), '2026-09-15T07:00:00.000Z');
  assert.equal(out.observedAt?.toISOString(), '2026-09-15T13:00:00.000Z');
});

test('manual attestation cannot leapfrog a lagging automated source', () => {
  const out = combineEvidenceClosure({
    hasAutomated: true,
    hasManual: true,
    automatedWatermark: d('2026-09-15T05:00:00Z'),
    automatedClaimedAt: d('2026-09-15T08:00:00Z'),
    manualThrough: d('2026-09-15T07:00:00Z'),
    manualClaimedAt: d('2026-09-15T13:00:00Z'),
  });
  assert.equal(out.watermark?.toISOString(), '2026-09-15T05:00:00.000Z');
  assert.equal(out.observedAt?.toISOString(), '2026-09-15T13:00:00.000Z');
});

test('missing automated closure blocks mixed evidence even when a human attests', () => {
  const out = combineEvidenceClosure({
    hasAutomated: true,
    hasManual: true,
    automatedWatermark: null,
    automatedClaimedAt: null,
    manualThrough: d('2026-09-15T07:00:00Z'),
    manualClaimedAt: d('2026-09-15T13:00:00Z'),
  });
  assert.equal(out.watermark, null);
  assert.equal(out.observedAt, null);
});

test('automated-only evidence does not require a human attestation', () => {
  const out = combineEvidenceClosure({
    hasAutomated: true,
    hasManual: false,
    automatedWatermark: d('2026-09-15T09:00:00Z'),
    automatedClaimedAt: d('2026-09-15T09:05:00Z'),
    manualThrough: null,
    manualClaimedAt: null,
  });
  assert.equal(out.watermark?.toISOString(), '2026-09-15T09:00:00.000Z');
});


test('historical closure uses the first watermark claim that crossed the interval cutoff', () => {
  const cutoff = d('2026-09-15T07:00:00Z');
  const claims = [
    { watermarkAt: d('2026-09-15T07:30:00Z'), claimedAt: d('2026-09-15T08:00:00Z') },
    { watermarkAt: d('2026-09-16T00:00:00Z'), claimedAt: d('2026-09-15T12:00:00Z') },
  ];
  const first = firstWatermarkClaimThrough(claims, cutoff);
  assert.equal(first?.claimedAt.toISOString(), '2026-09-15T08:00:00.000Z');

  const out = combineHistoricalEvidenceClosure({
    cutoff,
    automatedSources: [{ sourceSystemId: 'erp', claims }],
    hasManual: false,
    manualThrough: null,
    manualClaimedAt: null,
  });
  assert.equal(out.watermark?.toISOString(), '2026-09-15T07:30:00.000Z');
  assert.equal(out.observedAt?.toISOString(), '2026-09-15T08:00:00.000Z');
  assert.equal(out.automatedClaimedAtBySource.erp?.toISOString(), '2026-09-15T08:00:00.000Z');
});

test('a later automated sync cannot erase the knowledge time of the first closure claim', () => {
  const out = combineHistoricalEvidenceClosure({
    cutoff: d('2026-09-15T07:00:00Z'),
    automatedSources: [{
      sourceSystemId: 'erp',
      claims: [
        { watermarkAt: d('2026-09-15T08:00:00Z'), claimedAt: d('2026-09-15T09:00:00Z') },
        { watermarkAt: d('2026-09-16T08:00:00Z'), claimedAt: d('2026-09-16T09:00:00Z') },
      ],
    }],
    hasManual: true,
    manualThrough: d('2026-09-15T07:30:00Z'),
    manualClaimedAt: d('2026-09-15T10:00:00Z'),
  });
  assert.equal(out.automatedClaimedAtBySource.erp?.toISOString(), '2026-09-15T09:00:00.000Z');
  assert.equal(out.observedAt?.toISOString(), '2026-09-15T10:00:00.000Z');
});

test('historical closure refuses when any automated source never crossed the cutoff', () => {
  const out = combineHistoricalEvidenceClosure({
    cutoff: d('2026-09-15T07:00:00Z'),
    automatedSources: [
      { sourceSystemId: 'erp', claims: [{ watermarkAt: d('2026-09-15T08:00:00Z'), claimedAt: d('2026-09-15T09:00:00Z') }] },
      { sourceSystemId: 'production', claims: [{ watermarkAt: d('2026-09-15T06:00:00Z'), claimedAt: d('2026-09-15T09:30:00Z') }] },
    ],
    hasManual: true,
    manualThrough: d('2026-09-15T08:00:00Z'),
    manualClaimedAt: d('2026-09-15T10:00:00Z'),
  });
  assert.equal(out.watermark, null);
  assert.equal(out.observedAt, null);
  assert.equal(out.automatedClaimedAtBySource.erp?.toISOString(), '2026-09-15T09:00:00.000Z');
  assert.equal(out.automatedClaimedAtBySource.production, null);
});


test('historical closure refuses a manual assertion that does not reach the interval cutoff', () => {
  const cutoff = d('2026-09-08T12:00:00Z');
  const out = combineHistoricalEvidenceClosure({
    cutoff,
    automatedSources: [],
    hasManual: true,
    manualThrough: d('2026-09-08T11:59:59Z'),
    manualClaimedAt: d('2026-09-09T09:00:00Z'),
  });

  assert.equal(out.watermark, null);
  assert.equal(out.observedAt, null);
});

test('owner review advances accepted import knowledge without rewriting the original watermark claim', () => {
  const out = combineHistoricalEvidenceClosure({
    cutoff: d('2026-09-15T07:00:00Z'),
    automatedSources: [{
      sourceSystemId: 'nory',
      claims: [
        { watermarkAt: d('2026-09-15T08:00:00Z'), claimedAt: d('2026-09-15T09:00:00Z') },
        { watermarkAt: d('2026-09-16T08:00:00Z'), claimedAt: d('2026-09-16T09:00:00Z') },
      ],
    }],
    hasManual: false,
    manualThrough: null,
    manualClaimedAt: null,
    automatedReviews: [{
      sourceSystemId: 'nory',
      reviewedThroughImportedAt: d('2026-09-15T12:00:00Z'),
      reviewedAt: d('2026-09-15T13:00:00Z'),
    }],
  });

  assert.equal(out.automatedClaimedAtBySource.nory?.toISOString(), '2026-09-15T09:00:00.000Z');
  assert.equal(out.automatedKnowledgeCutoffBySource.nory?.toISOString(), '2026-09-15T12:00:00.000Z');
  assert.equal(out.observedAt?.toISOString(), '2026-09-15T13:00:00.000Z');
});

test('latest review only advances the accepted import cutoff; it does not replace watermark history', () => {
  const out = combineHistoricalEvidenceClosure({
    cutoff: d('2026-09-15T07:00:00Z'),
    automatedSources: [{
      sourceSystemId: 'nory',
      claims: [{ watermarkAt: d('2026-09-15T08:00:00Z'), claimedAt: d('2026-09-15T09:00:00Z') }],
    }],
    hasManual: false,
    manualThrough: null,
    manualClaimedAt: null,
    automatedReviews: [
      { sourceSystemId: 'nory', reviewedThroughImportedAt: d('2026-09-15T11:00:00Z'), reviewedAt: d('2026-09-15T11:30:00Z') },
      { sourceSystemId: 'nory', reviewedThroughImportedAt: d('2026-09-15T14:00:00Z'), reviewedAt: d('2026-09-15T14:30:00Z') },
    ],
  });

  assert.equal(out.watermark?.toISOString(), '2026-09-15T08:00:00.000Z');
  assert.equal(out.automatedClaimedAtBySource.nory?.toISOString(), '2026-09-15T09:00:00.000Z');
  assert.equal(out.automatedKnowledgeCutoffBySource.nory?.toISOString(), '2026-09-15T14:00:00.000Z');
});
