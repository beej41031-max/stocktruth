import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, type Analysis, type Answer } from '../src/analyse';
import { readCosts } from '../src/costs';
import { readTable } from '../src/csv';
import { buildReport, guessColumns } from '../src/report';
import type { ShopifySnapshot } from '../src/shopify';

const fixture = join(fileURLToPath(new URL('.', import.meta.url)), '../../adapter-shopify/examples/fixture');
const LEEDS = 'gid://shopify/Location/3001';
const snapshot = (): ShopifySnapshot => JSON.parse(readFileSync(join(fixture, 'snapshot.json'), 'utf8'));
const costText = 'sku,cost\nTEE-BLK-M,6.40\nTEE-BLK-L,6.40\nTEE-WHT-M,6.10\nHOOD-GRY-M,14.80\nHOOD-GRY-L,14.80\nTOTE-NAT,2.90\nSOCK-BLK-OS,1.85\nMUG-WHT,3.20\nBEANIE-NAVY,4.10\nCAP-BLK,5.20\nPIN-ENAMEL,0.85\n';

function report() {
  const table = readTable(readFileSync(join(fixture, '3pl-report.csv'), 'utf8'));
  const g = guessColumns(table.headers);
  return buildReport(
    table,
    { skuCol: g.sku, qtyCol: g.quantity[0]!, asOfCol: g.asOf, warehouseCol: g.warehouse, zone: 'UTC', dayFirst: true, reportTime: null, sumDuplicates: false },
    'Demo Fulfilment',
    'rep',
  ).report;
}

function run(answers: Answer[] = [], costs = readCosts(costText).units): Promise<Analysis> {
  return analyse({
    snapshot: snapshot(),
    report: report(),
    provider: 'Demo Fulfilment',
    locationMap: { LEEDS },
    basis: 'sellable',
    costs,
    answers,
  });
}

const row = (a: Analysis, sku: string, location?: string) => a.rows.find((r) => r.sku === sku && (!location || r.location === location))!;

test('reproduces what the engine says about the demo store', async () => {
  const a = await run();
  assert.equal(row(a, 'TEE-BLK-M').kind, 'agrees');
  assert.equal(row(a, 'TEE-BLK-M').position, 90);

  const l = row(a, 'TEE-BLK-L');
  assert.equal(l.kind, 'overstated');
  assert.equal(l.held, true);
  assert.equal(l.book, 68);
  assert.equal(l.evidence, 54);
  assert.equal(l.gap, -14);
  assert.equal(l.position, null);
  assert.equal(l.value, 14 * 6.4);

  assert.equal(row(a, 'TOTE-NAT').kind, 'unsized');
  assert.equal(row(a, 'MUG-WHT').kind, 'unsized');
  assert.equal(row(a, 'BEANIE-NAVY', 'Studio shop').kind, 'uncounted');
});

test('a gap is never netted against another and never turned into a pound figure it cannot support', async () => {
  const a = await run();
  assert.equal(a.overstated.rows, 1);
  assert.equal(a.understated.rows, 0);
  assert.equal(a.overstated.units, 14);
  assert.equal(a.overstated.value, 14 * 6.4);
  for (const r of a.rows.filter((r) => r.kind === 'unsized')) assert.equal(r.value, null);
});

test('without costs the answer is in units and says nothing about money', async () => {
  const a = await run([], new Map());
  assert.equal(a.valueBasis, null);
  assert.equal(a.overstated.value, null);
  assert.equal(a.overstated.units, 14);
  assert.equal(a.outsideValue, null);
});

test('selling price is used only when no costs exist at all', async () => {
  const a = await run([], readCosts('sku,price\nTEE-BLK-L,24\n').units);
  assert.equal(a.valueBasis, 'price');
  assert.equal(row(a, 'TEE-BLK-L').value, 14 * 24);
});

test('one question per location covers every gap there, with its value', async () => {
  const a = await run();
  const q = a.questions.find((q) => q.mode === 'location')!;
  assert.deepEqual(q.rows, [row(a, 'TEE-BLK-L').id]);
  assert.equal(q.value, 14 * 6.4);
  assert.match(q.headline, /Demo Fulfilment/);
  assert.equal(a.questions[0], q);
});

test('answering "nothing was changed" states the gap and takes it off the questions', async () => {
  const answer: Answer = { kind: 'no-changes', locationId: LEEDS, note: 'checked inventory history', at: '2026-09-23T09:00:00Z' };
  const a = await run([answer]);
  const l = row(a, 'TEE-BLK-L');
  assert.equal(l.held, false);
  assert.equal(l.kind, 'overstated');
  assert.equal(l.gap, -14);
  assert.equal(l.position, 54);
  assert.equal(l.onYourWord, true);
  assert.equal(a.questions.some((q) => q.mode === 'location'), false);
  assert.equal(a.answered, 1);
});

test('a "no changes" answer does not clear a refusal that has another cause', async () => {
  const a = await run([{ kind: 'no-changes', locationId: LEEDS, note: '', at: '2026-09-23T09:00:00Z' }]);
  assert.equal(row(a, 'TOTE-NAT').position, null);
  assert.equal(row(a, 'MUG-WHT').position, null);
});

test('an unseen receipt of the right size closes the gap, a wrong size leaves the remainder', async () => {
  const id = row(await run(), 'TEE-BLK-L').id;
  const exact = await run([{ kind: 'change', scopeId: id, direction: 'in', units: 14, only: true, note: 'hand adjustment', at: '2026-09-23T09:00:00Z' }]);
  assert.equal(row(exact, 'TEE-BLK-L').kind, 'agrees');
  assert.equal(row(exact, 'TEE-BLK-L').gap, 0);

  const short = await run([{ kind: 'change', scopeId: id, direction: 'in', units: 10, only: true, note: '', at: '2026-09-23T09:00:00Z' }]);
  assert.equal(row(short, 'TEE-BLK-L').gap, -4);
  const wrongWay = await run([{ kind: 'change', scopeId: id, direction: 'out', units: 14, only: true, note: '', at: '2026-09-23T09:00:00Z' }]);
  assert.equal(row(wrongWay, 'TEE-BLK-L').gap, -28);
});

test('a reported change is never given a time: it is not a step, and the position still follows from it', async () => {
  const before = row(await run(), 'TEE-BLK-L');
  const id = before.id;
  const a = await run([{ kind: 'change', scopeId: id, direction: 'in', units: 14, only: true, note: 'cycle count correction', at: '2026-09-23T09:00:00Z' }]);
  const l = row(a, 'TEE-BLK-L');
  assert.deepEqual(l.steps.map((x) => x.id), before.steps.map((x) => x.id), 'no step was added');
  assert.deepEqual(l.unplaced, [{ id: 'answer:2026-09-23T09:00:00Z', units: 14, note: 'cycle count correction' }]);
  assert.equal(l.position, 68, 'count 60, shipped and returned as before, plus the 14');
  assert.equal(l.evidence, l.book);
});

test('a reported change that cannot be placed blocks instead of being squeezed in', async () => {
  const a = await run();
  const stale = row(a, 'BEANIE-NAVY', 'Studio shop');
  const b = await run([{ kind: 'change', scopeId: stale.id, direction: 'in', units: 3, only: false, note: '', at: '2026-09-23T09:00:00Z' }]);
  assert.equal(row(b, 'BEANIE-NAVY', 'Studio shop').kind, 'uncounted');
});

test('telling the engine what an adjustment did lets it count again', async () => {
  const mug = row(await run(), 'MUG-WHT');
  assert.equal(mug.adjustments.length, 1);
  assert.match(mug.adjustments[0]!.label, /^(Order|Refund|Transfer)/);
  const movementId = mug.adjustments[0]!.id;
  for (const as of ['in', 'out', 'none'] as const) {
    const a = await run([{ kind: 'adjustment', scopeId: mug.id, movementId, as, note: '', at: '2026-09-23T09:00:00Z' }]);
    assert.equal(row(a, 'MUG-WHT').blockers.some((b) => b.code === 'ADJUSTMENT_IN_INTERVAL'), false, as);
    assert.equal(row(a, 'MUG-WHT').onYourWord, true);
  }
});

test('stock outside the engine is priced where a cost exists', async () => {
  const a = await run();
  const pin = a.outside.find((f) => f.id === 'unknown:PIN-ENAMEL')!;
  assert.equal(pin.units, 120);
  assert.equal(pin.value, 120 * 0.85);
  assert.ok(a.outside.some((f) => /rejected on receipt/.test(f.text)));
});

test('the staircase walks the count through every shipment to the expected figure', async () => {
  const l = row(await run(), 'TEE-BLK-L');
  const net = l.steps.filter((s) => s.insideBook).reduce((n, s) => n + s.signed, 0);
  assert.equal(l.count! + net, l.evidence);
  assert.ok(l.steps.every((s) => /^Order |^Refund|^Transfer/.test(s.label)));
});

test('a report older than the orders that were read is refused with a plain message', async () => {
  const snap = snapshot();
  snap.ordersSince = '2026-09-23T00:00:00Z';
  await assert.rejects(
    analyse({ snapshot: snap, report: report(), provider: 'P', locationMap: { LEEDS }, basis: 'sellable', costs: new Map(), answers: [] }),
    /before orders were read/,
  );
});
