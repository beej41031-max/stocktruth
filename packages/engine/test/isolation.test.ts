import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { asOfKnowledge } from '../src/asof';
import { explain } from '../src/explain';
import { reconcile } from '../src/reconcile';
import { DEFAULT_POLICY, type ReconciliationInput } from '../src/types';
import { InMemoryEvidenceSource } from './inmemory';

/**
 * Eight claims this system makes about itself, each proved rather than
 * asserted in a readme.
 */

const SITE = { siteId: 'site-1' };
const SCOPE = { itemId: 'item-1', locationId: 'loc-1' };

const ITEM = {
  id: 'item-1',
  sku: 'PKG-CAN-440',
  name: 'Can 440ml unprinted',
  stockUnit: 'each',
  active: true,
  blocked: false,
};

const t = (iso: string) => new Date(iso);

// ---------------------------------------------------------------------------
// 1. The engine runs with no database at all
// ---------------------------------------------------------------------------

test('the engine reaches every state through an adapter made of arrays', async () => {
  const src = new InMemoryEvidenceSource().addScope({
    item: ITEM,
    locationId: 'loc-1',
    book: null,
    count: null,
    movements: [],
    unlinkedMovementCount: 0,
    possiblyRelatedUnlinkedCount: 0,
    sources: [],
  });

  const scope = await src.loadScope(SITE, SCOPE);
  const r = reconcile({
    ...scope!,
    policy: DEFAULT_POLICY,
    evaluatedAt: t('2026-09-17T09:00:00Z'),
  });

  assert.equal(r.state, 'UNVERIFIED');
  assert.equal(r.derivedQuantity, null);
});

test('the engine imports nothing outside itself', () => {
  // The separation is only real if it is enforced. A single import of pg, or
  // of anything in apps/, would mean the engine had quietly learned about a
  // particular host again.
  const dir = join(import.meta.dirname, '..', 'src');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const raw = readFileSync(join(dir, file), 'utf8');

    // Comments are stripped first. A file explaining that it does not touch a
    // database should not fail a test looking for the word "database".
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');

    for (const spec of [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)) {
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        `${file} imports ${spec}. The engine may only import itself.`,
      );
    }

    // Nor may executable code contain a host's vocabulary.
    for (const word of ['supabase', 'pg.', 'require(', 'select ', 'insert into', 'process.env']) {
      assert.ok(
        !code.toLowerCase().includes(word),
        `${file} contains "${word}" in code. That belongs in an adapter.`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Occurrence time and knowledge time never collapse into each other
// ---------------------------------------------------------------------------

test('as-of cannot see evidence that had not arrived yet', async () => {
  const src = new InMemoryEvidenceSource()
    .addScope({
      item: ITEM,
      locationId: 'loc-1',
      book: null,
      count: null,
      movements: [],
      unlinkedMovementCount: 0,
      possiblyRelatedUnlinkedCount: 0,
      sources: [],
    })
    .addCount(
      SCOPE,
      {
        id: 'count-1',
        quantity: 27_600,
        unit: 'each',
        countedAt: t('2026-09-14T12:02:00Z'),
        receivedAt: t('2026-09-14T12:02:00Z'),
        countedBy: 'rana',
        sessionId: 'sess-1',
        sessionWatermark: null,
      },
      t('2026-09-14T12:02:00Z'),
    )
    // Arrived at 11:02. Not recorded until 15:02.
    .addMovement(
      SCOPE,
      {
        id: 'mv-pallet',
        type: 'RECEIVE',
        quantity: 8_400,
        unit: 'each',
        occurredAt: t('2026-09-14T11:02:00Z'),
        recordedAt: t('2026-09-14T15:02:00Z'),
        importedAt: t('2026-09-14T15:02:00Z'),
        sourceSystemId: 'src-1',
      },
      t('2026-09-14T15:02:00Z'),
    );

  const before = await asOfKnowledge(src, { site: SITE, scope: SCOPE, knownAt: t('2026-09-14T14:00:00Z') });
  const after = await asOfKnowledge(src, { site: SITE, scope: SCOPE, knownAt: t('2026-09-14T16:00:00Z') });

  // At 14:00 the delivery note had not arrived. The count stood on its own and
  // 27,600 was a defensible thing to say.
  assert.equal(before.result?.state, 'PROVISIONAL', 'provisional only because no book figure exists');
  assert.equal(before.result?.derivedQuantity, 27_600, 'a number was stateable at 14:00');

  // At 16:00 the note had arrived, and it could not be placed relative to the
  // count. Knowledge went backwards because evidence arrived, which is correct
  // rather than a fault.
  assert.equal(after.result?.state, 'INCOMPLETE');
  assert.equal(after.result?.derivedQuantity, null);
  assert.ok(after.result?.reasons.includes('MOVEMENT_SPANS_COUNT'));
});

test('an adapter that cannot answer historical questions is made to say so', async () => {
  const honest = new InMemoryEvidenceSource();
  Object.defineProperty(honest, 'supportsKnownAt', { value: false });

  const answer = await asOfKnowledge(honest, {
    site: SITE,
    scope: SCOPE,
    knownAt: t('2026-09-14T14:00:00Z'),
  });

  assert.equal(answer.supported, false);
  assert.match(answer.reason!, /cannot filter evidence by when it arrived/);
  assert.equal(answer.result, undefined, 'must not answer with today evidence');
});

// ---------------------------------------------------------------------------
// 3 and 4. A correction restores a refused position, deterministically
// ---------------------------------------------------------------------------

test('a later correction restores a position that was refused, without erasing anything', async () => {
  const src = new InMemoryEvidenceSource()
    .addScope({
      item: ITEM,
      locationId: 'loc-1',
      book: null,
      count: null,
      movements: [],
      unlinkedMovementCount: 0,
      possiblyRelatedUnlinkedCount: 0,
      sources: [],
    })
    .addCount(
      SCOPE,
      {
        id: 'count-1',
        quantity: 27_600,
        unit: 'each',
        countedAt: t('2026-09-14T12:02:00Z'),
        receivedAt: t('2026-09-14T12:02:00Z'),
        countedBy: 'rana',
        sessionId: 'sess-1',
        sessionWatermark: null,
      },
      t('2026-09-14T12:02:00Z'),
    )
    .addMovement(
      SCOPE,
      {
        id: 'mv-pallet',
        type: 'RECEIVE',
        quantity: 8_400,
        unit: 'each',
        occurredAt: t('2026-09-14T11:02:00Z'),
        recordedAt: t('2026-09-14T15:02:00Z'),
        importedAt: t('2026-09-14T15:02:00Z'),
        sourceSystemId: 'src-1',
      },
      t('2026-09-14T15:02:00Z'),
    );

  const stuck = await asOfKnowledge(src, { site: SITE, scope: SCOPE, knownAt: t('2026-09-15T09:00:00Z') });
  assert.equal(stuck.result?.state, 'INCOMPLETE');

  // Somebody counts it again on the 16th. That settles the question without
  // anybody having to remember what was on the shelf two days earlier.
  src.addCount(
    SCOPE,
    {
      id: 'count-2',
      quantity: 27_600,
      unit: 'each',
      countedAt: t('2026-09-16T09:30:00Z'),
      receivedAt: t('2026-09-16T09:30:00Z'),
      countedBy: 'sam',
      sessionId: 'sess-2',
      sessionWatermark: null,
    },
    t('2026-09-16T09:30:00Z'),
  );

  const fixed = await asOfKnowledge(src, { site: SITE, scope: SCOPE, knownAt: t('2026-09-17T09:00:00Z') });
  assert.equal(fixed.result?.state, 'PROVISIONAL', 'no book figure, so never fully verified');
  assert.equal(fixed.result?.derivedQuantity, 27_600, 'the recount settled it');
  assert.ok(!fixed.result?.reasons.includes('MOVEMENT_SPANS_COUNT'),
    'the newer count is after the awkward movement, so the ambiguity is gone');

  // And the earlier answer is unchanged. Recounting today does not rewrite
  // what the system honestly could not say on the 15th.
  const stillStuck = await asOfKnowledge(src, {
    site: SITE,
    scope: SCOPE,
    knownAt: t('2026-09-15T09:00:00Z'),
  });
  assert.equal(stillStuck.result?.state, 'INCOMPLETE');
  assert.equal(stillStuck.result?.derivedQuantity, null);
});

test('a reversal nets out without either half disappearing', async () => {
  const base = {
    item: ITEM,
    locationId: 'loc-1',
    book: null,
    count: {
      id: 'count-1',
      quantity: 100,
      unit: 'each',
      countedAt: t('2026-09-14T09:00:00Z'),
      receivedAt: t('2026-09-14T09:00:00Z'),
      countedBy: 'sam',
      sessionId: 's',
      sessionWatermark: null,
    },
    movements: [
      {
        id: 'mv-wrong',
        type: 'RECEIVE' as const,
        quantity: 40,
        unit: 'each',
        occurredAt: t('2026-09-15T09:00:00Z'),
        recordedAt: t('2026-09-15T09:00:00Z'),
        importedAt: t('2026-09-15T09:00:00Z'),
        sourceSystemId: 'src-1',
      },
      {
        id: 'mv-reversal',
        type: 'ISSUE' as const,
        quantity: 40,
        unit: 'each',
        occurredAt: t('2026-09-15T10:00:00Z'),
        recordedAt: t('2026-09-15T10:00:00Z'),
        importedAt: t('2026-09-15T10:00:00Z'),
        sourceSystemId: 'src-1',
        reversalOfId: 'mv-wrong',
      },
    ],
    unlinkedMovementCount: 0,
    possiblyRelatedUnlinkedCount: 0,
    sources: [],
    policy: DEFAULT_POLICY,
    evaluatedAt: t('2026-09-16T09:00:00Z'),
  };

  const r = reconcile(base);
  assert.equal(r.derivedQuantity, 100, 'the pair nets to nothing');
  assert.equal(r.evidence.movementIds.length, 2, 'both halves still counted as evidence');
  assert.ok(!r.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT'), 'a reversal is not a duplicate');
});

// ---------------------------------------------------------------------------
// 5. Determinism
// ---------------------------------------------------------------------------

test('the same evidence always produces the same state, reasons and number', () => {
  const input: ReconciliationInput = {
    item: ITEM,
    locationId: 'loc-1',
    book: {
      id: 'b1',
      quantity: 19_200,
      unit: 'each',
      asOf: t('2026-08-22T00:00:00Z'),
      sourceSystemId: 's1',
    },
    count: {
      id: 'c1',
      quantity: 27_600,
      unit: 'each',
      countedAt: t('2026-09-14T12:02:00Z'),
      receivedAt: t('2026-09-14T12:02:00Z'),
      countedBy: 'rana',
      sessionId: 'sess',
      sessionWatermark: null,
    },
    movements: [
      {
        id: 'm1',
        type: 'RECEIVE',
        quantity: 8_400,
        unit: 'each',
        occurredAt: t('2026-09-14T11:02:00Z'),
        recordedAt: t('2026-09-14T15:02:00Z'),
        importedAt: t('2026-09-14T15:02:00Z'),
        sourceSystemId: 's1',
      },
    ],
    unlinkedMovementCount: 0,
    possiblyRelatedUnlinkedCount: 0,
    sources: [],
    policy: DEFAULT_POLICY,
    evaluatedAt: t('2026-09-17T09:00:00Z'),
  };

  const runs = Array.from({ length: 20 }, () => explain(input));
  const first = JSON.stringify(runs[0]);
  for (const r of runs) {
    assert.equal(JSON.stringify(r), first, 'explain is not deterministic');
  }
});

// ---------------------------------------------------------------------------
// 6. Every blocker names the records and says what to do
// ---------------------------------------------------------------------------

test('the pallet blocker names the receipt, the count, the gap and two ways out', () => {
  const e = explain({
    item: ITEM,
    locationId: 'loc-1',
    book: null,
    count: {
      id: 'count-92abcdef',
      quantity: 27_600,
      unit: 'each',
      countedAt: t('2026-09-14T12:02:00Z'),
      receivedAt: t('2026-09-14T12:02:00Z'),
      countedBy: 'rana',
      sessionId: 'sess',
      sessionWatermark: null,
    },
    movements: [
      {
        id: 'mv-184abc',
        type: 'RECEIVE',
        quantity: 8_400,
        unit: 'each',
        occurredAt: t('2026-09-14T11:02:00Z'),
        recordedAt: t('2026-09-14T15:02:00Z'),
        importedAt: t('2026-09-14T15:02:00Z'),
        sourceSystemId: 's1',
      },
    ],
    unlinkedMovementCount: 0,
    possiblyRelatedUnlinkedCount: 0,
    sources: [],
    policy: DEFAULT_POLICY,
    evaluatedAt: t('2026-09-17T09:00:00Z'),
  });

  const blocker = e.blockers[0]!;
  const text = blocker.resolution;

  assert.match(text, /184ABC/, 'names the receipt');
  assert.match(text, /ABCDEF/, 'names the count');
  assert.match(text, /8400|8,400/, 'says how many');
  assert.match(text, /4 hours/, 'says how late the paperwork was');
  assert.match(text, /double-count/, 'says why it cannot just be applied');
  assert.match(text, /count .* again/i, 'offers the way out that needs nobody to remember');
});

test('every blocking reason produces a resolution that names something specific', () => {
  const cases: [string, ReconciliationInput][] = [
    [
      'ITEM_BLOCKED',
      base({ item: { ...ITEM, blocked: true, blockedReason: 'one code, two harvests' } }),
    ],
    ['AMBIGUOUS_ITEM_IDENTITY', base({ item: { ...ITEM, identityAmbiguous: true } })],
    ['NEVER_COUNTED', base({ count: null })],
    [
      'MOVEMENT_UNDATED',
      base({
        movements: [
          {
            id: 'mv-nodate',
            type: 'RECEIVE',
            quantity: 5,
            unit: 'each',
            occurredAt: null,
            recordedAt: null,
            importedAt: t('2026-09-15T09:00:00Z'),
            sourceSystemId: 's1',
          },
        ],
      }),
    ],
    ['MOVEMENT_MAY_BELONG_HERE', base({ possiblyRelatedUnlinkedCount: 2 })],
    [
      'NEGATIVE_DERIVED_POSITION',
      base({
        movements: [
          {
            id: 'mv-big',
            type: 'ISSUE',
            quantity: 9_999_999,
            unit: 'each',
            occurredAt: t('2026-09-15T09:00:00Z'),
            recordedAt: t('2026-09-15T09:00:00Z'),
            importedAt: t('2026-09-15T09:00:00Z'),
            sourceSystemId: 's1',
          },
        ],
      }),
    ],
  ];

  for (const [expected, input] of cases) {
    const e = explain(input);
    const blocker = e.blockers.find((b) => b.code === expected);
    assert.ok(blocker, `expected ${expected} to block`);
    assert.ok(
      blocker!.resolution.length > 40,
      `${expected} resolution is too thin to act on: ${blocker!.resolution}`,
    );
    assert.notEqual(
      blocker!.resolution,
      blocker!.code,
      `${expected} resolution is just the code repeated back`,
    );
  }
});

function base(over: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    item: ITEM,
    locationId: 'loc-1',
    book: null,
    count: {
      id: 'count-1',
      quantity: 100,
      unit: 'each',
      countedAt: t('2026-09-14T12:00:00Z'),
      receivedAt: t('2026-09-14T12:00:00Z'),
      countedBy: 'sam',
      sessionId: 'sess',
      sessionWatermark: null,
    },
    movements: [],
    unlinkedMovementCount: 0,
    possiblyRelatedUnlinkedCount: 0,
    sources: [],
    policy: DEFAULT_POLICY,
    evaluatedAt: t('2026-09-17T09:00:00Z'),
    ...over,
  };
}
