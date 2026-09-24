import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, explain, reconcile, type ReconciliationOutput, type ScopeEvidence } from '@stocktruth/engine';
import {
  ShopifyEvidenceSource,
  parseThreePlReport,
  readThreePlReport,
  type ShopifySnapshot,
} from '../src/index';
import { checkInvariant } from '../../engine/test/invariant';

/**
 * Each planted situation in the demo store, asserted against the engine's
 * actual output. If one of these fails, a merchant is being told something
 * false about their stock.
 */

const dir = join(fileURLToPath(new URL('.', import.meta.url)), '../examples/fixture');
const WH = 'gid://shopify/Location/3001';
const STUDIO = 'gid://shopify/Location/3002';
const snapshot = (): ShopifySnapshot => JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
const report = () => readThreePlReport(join(dir, '3pl-report.csv'), 'ParcelHouse Leeds', 'rep-0922');
const opts = { locationMap: { LEEDS: WH } };

async function run(snap = snapshot(), rep = report()) {
  const source = new ShopifyEvidenceSource(snap, rep, opts);
  const scopes = await source.loadSite({ siteId: 'x' });
  const inputFor = (s: ScopeEvidence) => ({
    item: s.item,
    locationId: s.locationId,
    book: s.book,
    count: s.count,
    movements: s.movements,
    unlinkedMovementCount: s.unlinkedMovementCount,
    possiblyRelatedUnlinkedCount: s.possiblyRelatedUnlinkedCount,
    sources: s.sources,
    policy: DEFAULT_POLICY,
    evaluatedAt: new Date(snap.fetchedAt),
    movementFeedComplete: s.movementFeedComplete,
  });
  const find = (sku: string, loc = WH, title?: string): ReconciliationOutput => {
    const s = scopes.find(
      (x) => x.item.sku === sku && x.locationId === loc && (!title || x.item.name.includes(title)),
    );
    assert.ok(s, `no scope for ${sku} at ${loc}`);
    return reconcile(inputFor(s));
  };
  return { source, scopes, find, inputFor };
}

test('a day of trading reconciles to the book: sales are not drift', async () => {
  const { find } = await run();
  const r = find('TEE-BLK-M');
  // 100 reported; 5 and 7 shipped; 2 shipped then cancelled; 2 returned; 1 refunded unrestocked.
  assert.equal(r.varianceAtCount, 0);
  assert.equal(r.derivedQuantity, 90);
  assert.equal(r.state, 'PROVISIONAL', 'never VERIFIED: Shopify hides manual adjustments');
});

test('the book is on_hand, not available: committed units are still on the shelf', async () => {
  const snap = snapshot();
  const tee = snap.variants.find((v) => v.sku === 'TEE-BLK-M')!;
  assert.equal(tee.levels[0]!.available, 87, 'fixture has 3 committed');
  const { scopes } = await run(snap);
  const s = scopes.find((x) => x.item.sku === 'TEE-BLK-M')!;
  assert.equal(s.book!.quantity, 90);
});

test('Shopify holding more than the evidence supports is reported, and not blamed on either side', async () => {
  const { find } = await run();
  const r = find('TEE-BLK-L');
  assert.equal(r.varianceAtCount, -14);
  assert.equal(r.derivedQuantity, null);
  assert.equal(r.state, 'INCOMPLETE');
  assert.ok(r.reasons.includes('BOOK_GAP_UNATTRIBUTABLE'));
});

test('a CANCEL restock is not stock coming back: it never shipped', async () => {
  const { find, source } = await run();
  const r = find('TEE-WHT-M');
  assert.equal(r.derivedQuantity, 36, 'counting the cancel restock would make it 37');
  assert.equal(r.varianceAtCount, 0);
  assert.equal(source.diagnostics().cancelRestocksSkipped, 1);
});

test('a RETURN restock is stock coming back', async () => {
  const { find } = await run();
  assert.equal(find('HOOD-GRY-M').derivedQuantity, 23);
});

test('a cancelled fulfilment becomes a shipment and its reversal, netting to nothing', async () => {
  const { scopes } = await run();
  const s = scopes.find((x) => x.item.sku === 'TEE-BLK-M')!;
  const cancel = s.movements.find((m) => m.reversalOfId);
  assert.ok(cancel, 'reversal present');
  const original = s.movements.find((m) => m.id === cancel.reversalOfId)!;
  assert.equal(original.type, 'ISSUE');
  assert.equal(cancel.type, 'RETURN');
  assert.equal(original.quantity, cancel.quantity);
});

test('two variants sharing a SKU get no number, because a 3PL line cannot tell them apart', async () => {
  const { find } = await run();
  for (const title of ['Canvas tote', 'old listing']) {
    const r = find('TOTE-NAT', WH, title);
    assert.equal(r.derivedQuantity, null);
    assert.ok(r.reasons.includes('AMBIGUOUS_ITEM_IDENTITY'));
  }
});

test('an untracked variant is a finding about the store, not a refused position', async () => {
  const { scopes, source } = await run();
  assert.ok(!scopes.some((s) => s.item.sku === 'CAP-BLK'), 'no book exists, so no scope');
  assert.deepEqual(source.diagnostics().untrackedHeldByThreePl, [{ sku: 'CAP-BLK', quantity: 12 }]);
});

test('a hand-typed line carrying a real SKU blocks that SKU, because it may be the same goods', async () => {
  const { find, source } = await run();
  const r = find('SOCK-BLK-OS');
  assert.equal(r.derivedQuantity, null);
  assert.ok(r.reasons.includes('MOVEMENT_MAY_BELONG_HERE'));
  assert.equal(source.diagnostics().unlinkedLines.length, 1);
});

test('a LEGACY_RESTOCK has no known direction and blocks rather than guessing', async () => {
  const { find } = await run();
  const r = find('MUG-WHT');
  assert.equal(r.derivedQuantity, null);
  assert.ok(r.reasons.includes('ADJUSTMENT_IN_INTERVAL'));
});

test('location scoping: a studio sale does not touch the 3PL position', async () => {
  const { find } = await run();
  assert.equal(find('BEANIE-NAVY').derivedQuantity, 40, '45 reported, 5 transferred out to the studio');
  const studio = find('BEANIE-NAVY', STUDIO);
  assert.equal(studio.derivedQuantity, null);
  assert.ok(studio.reasons.includes('NEVER_COUNTED'));
});

test('stock the 3PL holds that Shopify has never heard of is surfaced', async () => {
  const { source } = await run();
  assert.deepEqual(source.diagnostics().unknownThreePlSkus, [{ sku: 'PIN-ENAMEL', quantity: 120, row: 11 }]);
});

test('every scope declares the feed partial, and the refusal invariant holds on all of them', async () => {
  const { scopes, inputFor } = await run();
  for (const s of scopes) {
    assert.equal(s.movementFeedComplete, false);
    assert.equal(checkInvariant(inputFor(s)), null, `${s.item.sku} at ${s.locationId}`);
  }
});

test('the gap is explained in the merchant\'s terms', async () => {
  const { scopes, inputFor } = await run();
  const e = explain(inputFor(scopes.find((s) => s.item.sku === 'TEE-BLK-L')!));
  assert.match(e.blockers[0]!.resolution, /add up to 54 each; the system says 68/);
});

// --- refusals the adapter makes itself ----------------------------------------

test('a report older than the order window is refused, not quietly carried forward', () => {
  const snap = snapshot();
  snap.ordersSince = '2026-09-22T12:00:00Z';
  assert.throws(() => new ShopifyEvidenceSource(snap, report(), opts), /before orders were read/);
});

test('an unmapped 3PL warehouse is refused', () => {
  assert.throws(() => new ShopifyEvidenceSource(snapshot(), report(), { locationMap: {} }), /not mapped/);
});

test('two report lines for one SKU at one location are refused', () => {
  const rep = parseThreePlReport(
    'sku,quantity,as_of,warehouse\nTEE-BLK-M,10,2026-09-22T06:00:00Z,LEEDS\ntee-blk-m,12,2026-09-22T06:00:00Z,LEEDS\n',
    '3PL',
    'r',
  );
  assert.throws(() => new ShopifyEvidenceSource(snapshot(), rep, opts), /two lines for tee-blk-m/i);
});

test('the report parser refuses times with no zone, fractions and negatives', () => {
  const head = 'sku,quantity,as_of\n';
  assert.throws(() => parseThreePlReport(head + 'A,1,2026-09-22T06:00:00\n', '3PL', 'r'), /no timezone/);
  assert.throws(() => parseThreePlReport(head + 'A,1.5,2026-09-22T06:00:00Z\n', '3PL', 'r'), /whole number/);
  assert.throws(() => parseThreePlReport(head + 'A,-3,2026-09-22T06:00:00Z\n', '3PL', 'r'), /whole number/);
  assert.throws(() => parseThreePlReport('sku,qty\nA,1\n', '3PL', 'r'), /missing column "quantity"/);
});

// --- transfers, unavailable stock, older snapshots ---------------------------

test('a shipped transfer is a movement at the origin, not an unexplained gap', async () => {
  const { find } = await run();
  const r = find('BEANIE-NAVY');
  assert.equal(r.varianceAtCount, 0, 'without transfers this read as a 5-unit gap');
  assert.ok(!r.reasons.includes('BOOK_GAP_UNATTRIBUTABLE'));
});

test('only accepted units arrive; rejected units are a finding, not stock', async () => {
  const { scopes, source } = await run();
  const studio = scopes.find((s) => s.item.sku === 'BEANIE-NAVY' && s.locationId === STUDIO)!;
  const inbound = studio.movements.filter((m) => m.type === 'TRANSFER_IN');
  assert.deepEqual(inbound.map((m) => m.quantity), [3]);
  assert.deepEqual(source.diagnostics().rejectedTransferUnits, [{ transfer: '#T61', sku: 'BEANIE-NAVY', quantity: 2 }]);
});

test('a draft or ready-to-ship transfer is a hold and moves nothing', async () => {
  const { scopes, find } = await run();
  const tee = scopes.find((s) => s.item.sku === 'TEE-WHT-M')!;
  assert.ok(!tee.movements.some((m) => m.type.startsWith('TRANSFER')));
  assert.equal(find('TEE-WHT-M').derivedQuantity, 36);
});

test('a receipt with no origin is a receipt, not a transfer', async () => {
  const snap = snapshot();
  snap.transfers![0]!.originLocationId = null;
  const { scopes } = await run(snap);
  const studio = scopes.find((s) => s.item.sku === 'BEANIE-NAVY' && s.locationId === STUDIO)!;
  assert.ok(studio.movements.some((m) => m.type === 'RECEIVE' && m.quantity === 3));
});

test('on a sellable basis, damaged stock inside on-hand does not invent a gap', async () => {
  const source = new ShopifyEvidenceSource(snapshot(), report(), { ...opts, threePlBasis: 'sellable' });
  const s = (await source.loadSite({ siteId: 'x' })).find((x) => x.item.sku === 'HOOD-GRY-L')!;
  assert.equal(s.book!.quantity, 20);
});

test('on an on-hand basis, the same stock is compared as-is and flagged as a likely basis mismatch', async () => {
  const { find, source } = await run();
  const r = find('HOOD-GRY-L');
  assert.equal(r.varianceAtCount, -2);
  assert.deepEqual(source.diagnostics().unavailableInBook, [{ sku: 'HOOD-GRY-L', quantity: 2 }]);
});

test('an older snapshot without transfers still loads, and says transfers were not read', async () => {
  const snap = snapshot();
  delete snap.transfers;
  const { source } = await run(snap);
  assert.equal(source.diagnostics().transfersRead, false);
});

test('a sellable basis is refused on a snapshot that never read damaged stock', () => {
  const snap = snapshot();
  for (const v of snap.variants) for (const l of v.levels) delete l.damaged;
  assert.throws(
    () => new ShopifyEvidenceSource(snap, report(), { ...opts, threePlBasis: 'sellable' }),
    /predates damaged/,
  );
});

// --- receipts at the 3PL, from the 24 September validation --------------------

function inboundToWarehouse(snap: ShopifySnapshot, shipment: {
  status: string; shipped: string; firstReceived: string; accepted: number; unreceived: number;
}, onHandAt3pl: number) {
  const tee = snap.variants.find((v) => v.sku === 'TEE-BLK-M')!;
  tee.levels.find((l) => l.locationId === WH)!.onHand = onHandAt3pl;
  snap.transfers = [
    ...(snap.transfers ?? []),
    {
      id: 'gid://shopify/InventoryTransfer/88',
      name: '#T88',
      status: 'IN_PROGRESS',
      originLocationId: STUDIO,
      destinationLocationId: WH,
      shipments: [
        {
          id: 'gid://shopify/InventoryShipment/881',
          status: shipment.status,
          dateCreated: shipment.shipped,
          dateShipped: shipment.shipped,
          dateReceived: shipment.firstReceived,
          lines: [
            {
              inventoryItemId: tee.inventoryItemId,
              sku: 'TEE-BLK-M',
              quantity: 5,
              accepted: shipment.accepted,
              rejected: 0,
              unreceived: shipment.unreceived,
            },
          ],
        },
      ],
    },
  ];
  return snap;
}

test('a partial receipt after the report adds exactly the accepted units (validation step 8)', async () => {
  // 5 shipped at 07:00, 3 accepted at 09:00, 2 still unreceived. Shopify: 90 + 3.
  const snap = inboundToWarehouse(
    snapshot(),
    { status: 'PARTIALLY_RECEIVED', shipped: '2026-09-22T07:00:00Z', firstReceived: '2026-09-22T09:00:00Z', accepted: 3, unreceived: 2 },
    93,
  );
  const { find } = await run(snap);
  const r = find('TEE-BLK-M');
  assert.equal(r.varianceAtCount, 0, 'the 2 unreceived units are not expected at the 3PL');
  assert.equal(r.derivedQuantity, 93);
});

test('a receipt in two batches either side of the report is refused, never falsely agreed', async () => {
  // Batch one (3) arrived at 05:00, before the 06:00 report, so the report's
  // 100 already includes it. Batch two (2) arrived at 10:00. Shopify only
  // records the first receipt time, so the adapter books all 5 at 05:00 and
  // cannot place batch two. Shopify holds 100 - 10 net trading + 2 = 92.
  const snap = inboundToWarehouse(
    snapshot(),
    { status: 'RECEIVED', shipped: '2026-09-21T20:00:00Z', firstReceived: '2026-09-22T05:00:00Z', accepted: 5, unreceived: 0 },
    92,
  );
  const { find } = await run(snap);
  const r = find('TEE-BLK-M');
  assert.equal(r.derivedQuantity, null, 'no position is stated');
  assert.ok(r.reasons.includes('BOOK_GAP_UNATTRIBUTABLE'));
  assert.equal(r.varianceAtCount, -2, 'the gap is the undated batch, and it is reported');
});
