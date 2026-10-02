import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTable } from '../src/csv';
import { buildReport, guessColumns, looksSellable, parseWhen, ReportError, zonedToDate, type ReportOptions } from '../src/report';
import { parseMoney, readCosts } from '../src/costs';

const base: ReportOptions = {
  skuCol: 0,
  qtyCol: 1,
  asOfCol: 2,
  warehouseCol: null,
  zone: 'Europe/London',
  dayFirst: true,
  reportTime: null,
  sumDuplicates: false,
};

test('wall clock in London becomes the right instant either side of the clock change', () => {
  assert.equal(zonedToDate(2026, 9, 22, 6, 0, 0, 'Europe/London').toISOString(), '2026-09-22T05:00:00.000Z');
  assert.equal(zonedToDate(2026, 12, 1, 6, 0, 0, 'Europe/London').toISOString(), '2026-12-01T06:00:00.000Z');
  assert.equal(zonedToDate(2026, 10, 25, 0, 30, 0, 'Europe/London').toISOString(), '2026-10-24T23:30:00.000Z');
  assert.equal(zonedToDate(2026, 3, 29, 12, 0, 0, 'Europe/London').toISOString(), '2026-03-29T11:00:00.000Z');
  assert.equal(zonedToDate(2026, 9, 22, 6, 0, 0, 'UTC').toISOString(), '2026-09-22T06:00:00.000Z');
  assert.equal(zonedToDate(2026, 9, 22, 6, 0, 0, 'Australia/Sydney').toISOString(), '2026-09-21T20:00:00.000Z');
});

test('dates: zoned ISO is kept as written, local ISO takes the chosen zone', () => {
  const o = { zone: 'Europe/London', dayFirst: true, timeOfDay: null };
  assert.equal((parseWhen('2026-09-22T06:00:00Z', o) as { at: Date }).at.toISOString(), '2026-09-22T06:00:00.000Z');
  assert.equal((parseWhen('2026-09-22 06:00:00+0100', o) as { at: Date }).at.toISOString(), '2026-09-22T05:00:00.000Z');
  assert.equal((parseWhen('2026-09-22 06:00', o) as { at: Date }).at.toISOString(), '2026-09-22T05:00:00.000Z');
});

test('dates: day-first and month-first are read differently, and say so when impossible', () => {
  const o = { zone: 'UTC', dayFirst: true, timeOfDay: null };
  assert.equal((parseWhen('03/04/2026 08:15', o) as { at: Date }).at.toISOString(), '2026-04-03T08:15:00.000Z');
  assert.equal((parseWhen('03/04/2026 08:15', { ...o, dayFirst: false }) as { at: Date }).at.toISOString(), '2026-03-04T08:15:00.000Z');
  assert.ok('error' in parseWhen('22/13/2026 08:15', { ...o, dayFirst: false }));
  assert.ok('error' in parseWhen('yesterday', o));
});

test('a date with no time needs the time the report was run', () => {
  const o = { zone: 'UTC', dayFirst: true, timeOfDay: null };
  const none = parseWhen('22/09/2026', o);
  assert.ok('error' in none && /no time/.test(none.error));
  assert.equal((parseWhen('22/09/2026', { ...o, timeOfDay: '06:30' }) as { at: Date }).at.toISOString(), '2026-09-22T06:30:00.000Z');
});

test('guessing columns from headers a real 3PL might use', () => {
  const g = guessColumns(['Item Code', 'Description', 'Qty On Hand', 'Qty Available', 'Warehouse', 'Report Date']);
  assert.equal(g.sku, 0);
  assert.deepEqual(g.quantity.slice(0, 2), [2, 3]);
  assert.equal(g.warehouse, 4);
  assert.equal(g.asOf, 5);
  assert.equal(looksSellable('Qty Available'), true);
  assert.equal(looksSellable('Qty On Hand'), false);
});

test('reads a semicolon file with quotes and a byte order mark', () => {
  const t = readTable('\uFEFFsku;quantity;as_of\r\n"A;1";12;2026-09-22T06:00:00Z\r\nB-2;7;2026-09-22T06:00:00Z\r\n');
  assert.equal(t.delimiter, ';');
  assert.deepEqual(t.rows[0], ['A;1', '12', '2026-09-22T06:00:00Z']);
  const { report } = buildReport(t, base, 'P', 'r');
  assert.equal(report.lines.length, 2);
  assert.equal(report.lines[1]!.sku, 'B-2');
});

test('quantities: thousands separators pass, decimals and negatives are refused with the row', () => {
  const t = readTable('sku,quantity,as_of\nA,"1,250",2026-09-22T06:00:00Z\nB,3.5,2026-09-22T06:00:00Z\nC,-4,2026-09-22T06:00:00Z\n');
  assert.throws(() => buildReport(t, base, 'P', 'r'), (e) => e instanceof ReportError && /row 3/.test(e.message) && /row 4/.test(e.message));
  const ok = readTable('sku,quantity,as_of\nA,"1,250",2026-09-22T06:00:00Z\nD,8.0,2026-09-22T06:00:00Z\n');
  assert.deepEqual(buildReport(ok, base, 'P', 'r').report.lines.map((l) => l.quantity), [1250, 8]);
});

test('total rows are skipped and said so', () => {
  const t = readTable('sku,quantity,as_of\nA,5,2026-09-22T06:00:00Z\nTotal,5,\n');
  const { report, notes } = buildReport(t, base, 'P', 'r');
  assert.equal(report.lines.length, 1);
  assert.match(notes[0]!, /Skipped 1 total/);
});

test('a file with no time column takes the report time on the 3PL clock', () => {
  const t = readTable('sku,qty\nA,5\n');
  const { report } = buildReport(t, { ...base, asOfCol: null, reportTime: '2026-09-22T06:00' }, 'P', 'r');
  assert.equal(report.lines[0]!.asOf.toISOString(), '2026-09-22T05:00:00.000Z');
  assert.throws(() => buildReport(t, { ...base, asOfCol: null, reportTime: null }, 'P', 'r'), /say when/);
});

test('duplicate SKUs: refused by default, added up on request, never when the times differ', () => {
  const t = readTable('sku,quantity,as_of\nA,5,2026-09-22T06:00:00Z\nA,7,2026-09-22T06:00:00Z\n');
  assert.throws(() => buildReport(t, base, 'P', 'r'), /rows 2 and 3/);
  const { report, notes } = buildReport(t, { ...base, sumDuplicates: true }, 'P', 'r');
  assert.equal(report.lines[0]!.quantity, 12);
  assert.match(notes[0]!, /Added up 1/);
  const skew = readTable('sku,quantity,as_of\nA,5,2026-09-22T06:00:00Z\nA,7,2026-09-22T07:00:00Z\n');
  assert.throws(() => buildReport(skew, { ...base, sumDuplicates: true }, 'P', 'r'), /different times/);
});

test('costs: money formats, header guessing, and a bare two-column paste', () => {
  assert.equal(parseMoney('£6.40'), 6.4);
  assert.equal(parseMoney('6,40'), 6.4);
  assert.equal(parseMoney('1,250.50'), 1250.5);
  assert.equal(parseMoney('n/a'), null);
  const shopify = readCosts('Handle,Variant SKU,Variant Price,Cost per item\ntee,TEE-BLK-M,24.00,6.40\ntee,,,\n');
  assert.equal(shopify.units.get('TEE-BLK-M')!.cost, 6.4);
  assert.equal(shopify.units.get('TEE-BLK-M')!.price, 24);
  const paste = readCosts('TEE-BLK-L,6.40\nMUG-WHT,3.20\n');
  assert.equal(paste.units.get('MUG-WHT')!.cost, 3.2);
  assert.throws(() => readCosts('foo,bar\n1,2\n'), /SKU column/);
});
