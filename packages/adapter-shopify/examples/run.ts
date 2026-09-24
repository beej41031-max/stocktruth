/**
 * Shopify stock against a 3PL's report, through the StockTruth engine.
 *
 *   npx tsx examples/run.ts                     the demo store in examples/fixture
 *
 *   SHOPIFY_SHOP=your-store \
 *   SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... \   (a Dev Dashboard app)
 *   or SHOPIFY_ADMIN_TOKEN=shpat_... \                  (an older admin-created app)
 *   THREEPL_REPORT=./report.csv THREEPL_PROVIDER="Your 3PL" \
 *   THREEPL_LOCATIONS="LEEDS=gid://shopify/Location/123" \
 *   ORDERS_SINCE=2026-09-21T00:00:00Z \
 *   npx tsx examples/run.ts                     a real store, read-only
 *
 * SAVE_SNAPSHOT=path.json writes what was read, so a live run can be replayed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, explain, reconcile, type ReconciliationInput } from '@stocktruth/engine';
import {
  ShopifyAdminClient,
  ShopifyEvidenceSource,
  fetchShopifySnapshot,
  readThreePlReport,
  type ShopifySnapshot,
} from '../src/index';

const here = fileURLToPath(new URL('.', import.meta.url));
const env = process.env;
const live = Boolean(
  env.SHOPIFY_SHOP && (env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)),
);

let snapshot: ShopifySnapshot;
let reportPath: string;
let provider: string;
let locationMap: Record<string, string>;
let evaluatedAt: Date;

if (live) {
  for (const k of ['THREEPL_REPORT', 'THREEPL_LOCATIONS', 'ORDERS_SINCE']) {
    if (!env[k]) throw new Error(`${k} is required for a live run`);
  }
  const client = env.SHOPIFY_ADMIN_TOKEN
    ? new ShopifyAdminClient({ shop: env.SHOPIFY_SHOP!, accessToken: env.SHOPIFY_ADMIN_TOKEN })
    : new ShopifyAdminClient({
        shop: env.SHOPIFY_SHOP!,
        clientId: env.SHOPIFY_CLIENT_ID!,
        clientSecret: env.SHOPIFY_CLIENT_SECRET!,
      });
  console.log(`reading ${client.shop} (read-only, API ${client.apiVersion})...`);
  snapshot = await fetchShopifySnapshot(client, {
    ordersSince: new Date(env.ORDERS_SINCE!),
    readAllOrdersGranted: env.READ_ALL_ORDERS === '1',
    onPage: (what, n) => process.stdout.write(`\r  ${what}: ${n}      `),
  });
  process.stdout.write('\n');
  if (env.SAVE_SNAPSHOT) writeFileSync(env.SAVE_SNAPSHOT, JSON.stringify(snapshot, null, 2));
  reportPath = env.THREEPL_REPORT!;
  provider = env.THREEPL_PROVIDER ?? '3PL';
  locationMap = Object.fromEntries(
    env.THREEPL_LOCATIONS!.split(',').map((pair) => pair.split('=').map((s) => s.trim()) as [string, string]),
  );
  evaluatedAt = new Date(snapshot.fetchedAt);
} else {
  snapshot = JSON.parse(readFileSync(join(here, 'fixture/snapshot.json'), 'utf8'));
  reportPath = join(here, 'fixture/3pl-report.csv');
  provider = 'ParcelHouse Leeds';
  locationMap = { LEEDS: 'gid://shopify/Location/3001' };
  evaluatedAt = new Date(snapshot.fetchedAt);
}

const report = readThreePlReport(reportPath, provider, 'report');
const threePlBasis = (live ? env.THREEPL_BASIS : 'sellable') === 'sellable' ? 'sellable' : 'on_hand';
const source = new ShopifyEvidenceSource(snapshot, report, { locationMap, threePlBasis });
const site = { siteId: snapshot.shop };
const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy(site)) };
const locationName = new Map(snapshot.locations.map((l) => [l.id, l.name]));

console.log(`3PL comparison basis: ${threePlBasis === 'sellable' ? 'sellable (excludes damaged and QC)' : 'on hand'}`);
const reportAt = report.lines.length ? report.lines[0]!.asOf.toISOString().slice(0, 16).replace('T', ' ') : 'n/a';
console.log(`\n${snapshot.shop}   Shopify read ${snapshot.fetchedAt.slice(0, 16).replace('T', ' ')}Z   ` +
  `${provider} report ${reportAt}Z\n`);
console.log(
  'SKU'.padEnd(13) + 'LOCATION'.padEnd(26) + 'SHOPIFY'.padStart(8) + 'EVIDENCE'.padStart(10) +
    'GAP'.padStart(6) + '   ' + 'POSITION'.padEnd(18) + 'STATE',
);
console.log('-'.repeat(95));

const refusals: { sku: string; lines: string[] }[] = [];
for (const scope of await source.loadSite(site)) {
  const input: ReconciliationInput = {
    item: scope.item,
    locationId: scope.locationId,
    book: scope.book,
    count: scope.count,
    movements: scope.movements,
    unlinkedMovementCount: scope.unlinkedMovementCount,
    possiblyRelatedUnlinkedCount: scope.possiblyRelatedUnlinkedCount,
    sources: scope.sources,
    policy,
    evaluatedAt,
    movementFeedComplete: scope.movementFeedComplete,
  };
  const r = reconcile(input);
  const e = explain(input);

  const book = r.bookQuantity;
  const gap = r.varianceAtCount;
  // Evidence at the book's moment: the count carried through visible movements.
  const evidence = book != null && gap != null ? book + gap : null;
  const loc = (locationName.get(scope.locationId ?? '') ?? scope.locationId ?? '').slice(0, 24);
  const sku = scope.item.sku ?? scope.item.id;

  console.log(
    sku.padEnd(13) + loc.padEnd(26) + fmt(book).padStart(8) + fmt(evidence).padStart(10) +
      (gap == null ? '' : gap === 0 ? '0' : (gap > 0 ? '+' : '') + gap).padStart(6) + '   ' +
      (r.derivedQuantity == null ? 'CANNOT BE STATED' : String(r.derivedQuantity)).padEnd(18) + r.state,
  );
  if (e.refused) refusals.push({ sku: `${sku} @ ${loc}`, lines: e.blockers.map((b) => b.resolution) });
}

console.log('\nWhy some positions are refused:\n');
for (const r of refusals) {
  console.log(`  ${r.sku}`);
  for (const line of r.lines) console.log(wrap(line, 90, '    - ', '      '));
}

const d = source.diagnostics();
console.log('\nOutside the engine:\n');
for (const u of d.unknownThreePlSkus) {
  console.log(`  ${provider} holds ${u.quantity} x ${u.sku}, which Shopify has no variant for (report row ${u.row}).`);
}
for (const u of d.unlinkedLines) {
  console.log(`  Order ${u.order} shipped ${u.quantity} x "${u.title}" (sku "${u.sku ?? ''}") with no product behind it.`);
}
if (d.cancelRestocksSkipped) {
  console.log(`  ${d.cancelRestocksSkipped} refund line(s) restocked as CANCEL: never shipped, so not counted as stock coming back.`);
}
if (d.noRestockLines) console.log(`  ${d.noRestockLines} refund line(s) not restocked.`);
for (const u of d.untrackedHeldByThreePl) {
  console.log(`  ${provider} holds ${u.quantity} x ${u.sku}, but Shopify does not track its stock, so it can be sold without limit.`);
}
for (const r of d.rejectedTransferUnits) {
  console.log(`  Transfer ${r.transfer}: ${r.quantity} x ${r.sku ?? '?'} rejected on receipt. Left the origin, stocked nowhere.`);
}
for (const u of d.unavailableInBook) {
  console.log(`  ${u.sku}: ${u.quantity} damaged or in QC inside Shopify's on-hand. If the 3PL report leaves these out, set THREEPL_BASIS=sellable.`);
}
if (!d.transfersRead) console.log('  This snapshot was taken before transfers were read; transfers will show as unexplained gaps.');
if (d.duplicateSkus.length) console.log(`  SKUs used by more than one variant: ${d.duplicateSkus.join(', ')}.`);
console.log(
  '\nShopify cannot show manual adjustments through its API. Where Shopify and the evidence disagree,\n' +
    'the gap is reported but not blamed on either side.\n',
);

function fmt(n: number | null): string {
  return n == null ? '-' : String(n);
}

function wrap(text: string, width: number, first: string, rest: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = first;
  for (const w of words) {
    if (line.length + w.length > width && line.trim() !== first.trim()) {
      out.push(line.trimEnd());
      line = rest;
    }
    line += w + ' ';
  }
  out.push(line.trimEnd());
  return out.join('\n');
}
