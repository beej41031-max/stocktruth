import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CsvEvidenceSource, parseCsv } from '../src/index';
import { DEFAULT_POLICY, reconcile } from '@stocktruth/engine';

test('CSV parser handles quoted commas, escaped quotes and embedded newlines', () => {
  const rows = parseCsv('a,b\n"hello, world","say ""yes"""\n"two\nlines",ok\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['hello, world', 'say "yes"'],
    ['two\nlines', 'ok'],
  ]);
});

test('CSV adapter drives the same engine without a database', async () => {
  const dir = join(import.meta.dirname, '..', 'examples');
  const source = new CsvEvidenceSource(dir, { receivedAt: new Date('2026-09-17T08:55:00Z') });
  assert.equal(source.supportsKnownAt, false);
  const site = { siteId: 'stationer-01' };
  const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy(site)) };
  const scopes = await source.loadSite(site);
  assert.ok(scopes.length >= 4);
  const envelope = scopes.find((scope) => scope.item.sku === 'ENV-C5-WHT');
  assert.ok(envelope);
  const result = reconcile({ ...envelope, policy, evaluatedAt: new Date('2026-09-17T09:00:00Z') });
  assert.equal(result.derivedQuantity, null);
  assert.ok(result.reasons.includes('MOVEMENT_SPANS_COUNT'));
});

test('CSV adapter refuses malformed numbers instead of smuggling NaN into the engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stocktruth-csv-'));
  writeFileSync(join(dir, 'items.csv'), 'id,sku,name,unit,active,blocked\n1,A,Thing,each,true,false\n');
  writeFileSync(join(dir, 'book.csv'), 'item_id,quantity,unit,as_of\n1,nope,each,2026-09-01T00:00:00Z\n');
  writeFileSync(join(dir, 'counts.csv'), 'item_id,quantity,unit,counted_at\n1,5,each,2026-09-02T00:00:00Z\n');
  writeFileSync(join(dir, 'movements.csv'), 'item_id,type,quantity,unit,occurred_at,recorded_at\n');
  assert.throws(() => new CsvEvidenceSource(dir), /finite number/);
});

test('CSV adapter rejects negative movement quantities instead of turning direction inside out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stocktruth-csv-negative-'));
  writeFileSync(join(dir, 'items.csv'), 'id,sku,name,unit,active,blocked\n1,A,Thing,each,true,false\n');
  writeFileSync(join(dir, 'book.csv'), 'item_id,quantity,unit,as_of\n1,20,each,2026-09-01T00:00:00Z\n');
  writeFileSync(join(dir, 'counts.csv'), 'item_id,quantity,unit,counted_at\n1,20,each,2026-09-02T00:00:00Z\n');
  writeFileSync(join(dir, 'movements.csv'), 'item_id,type,quantity,unit,occurred_at,recorded_at\n1,RECEIVE,-5,each,2026-09-03T00:00:00Z,2026-09-03T00:00:00Z\n');
  assert.throws(() => new CsvEvidenceSource(dir), /must be non-negative/);
});

test('CSV duplicate SKUs mark every owner ambiguous so neither scope prints a stock number', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stocktruth-csv-duplicate-sku-'));
  writeFileSync(join(dir, 'items.csv'), 'id,sku,name,unit,active,blocked\n1,DUP,Thing one,each,true,false\n2,dup,Thing two,each,true,false\n');
  writeFileSync(join(dir, 'book.csv'), 'item_id,quantity,unit,as_of\n1,8,each,2026-09-01T00:00:00Z\n2,9,each,2026-09-01T00:00:00Z\n');
  writeFileSync(join(dir, 'counts.csv'), 'item_id,quantity,unit,counted_at\n1,8,each,2026-09-02T00:00:00Z\n2,9,each,2026-09-02T00:00:00Z\n');
  writeFileSync(join(dir, 'movements.csv'), 'item_id,type,quantity,unit,occurred_at,recorded_at\n');

  const source = new CsvEvidenceSource(dir, { receivedAt: new Date('2026-09-03T00:00:00Z') });
  const scopes = await source.loadSite({ siteId: 'csv' });
  assert.equal(scopes.length, 2);
  for (const scope of scopes) {
    const r = reconcile({ ...scope, policy: DEFAULT_POLICY, evaluatedAt: new Date('2026-09-03T00:00:00Z') });
    assert.equal(r.state, 'CONFLICT');
    assert.equal(r.derivedQuantity, null);
    assert.ok(r.reasons.includes('AMBIGUOUS_ITEM_IDENTITY'));
  }
});

test('CSV site output can show STALE while inactive items remain deliberately absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stocktruth-csv-stale-inactive-'));
  writeFileSync(join(dir, 'items.csv'), 'id,sku,name,unit,active,blocked\n1,OLD,Old active,each,true,false\n2,OFF,Retired,each,false,false\n');
  writeFileSync(join(dir, 'book.csv'), 'item_id,quantity,unit,as_of\n1,5,each,2026-06-01T00:00:00Z\n2,4,each,2026-06-01T00:00:00Z\n');
  writeFileSync(join(dir, 'counts.csv'), 'item_id,quantity,unit,counted_at\n1,5,each,2026-06-15T00:00:00Z\n2,4,each,2026-09-19T00:00:00Z\n');
  writeFileSync(join(dir, 'movements.csv'), 'item_id,type,quantity,unit,occurred_at,recorded_at\n');

  const evaluatedAt = new Date('2026-09-20T00:00:00Z');
  const source = new CsvEvidenceSource(dir, { receivedAt: evaluatedAt });
  const scopes = await source.loadSite({ siteId: 'csv' });
  assert.equal(scopes.length, 1, 'inactive item is intentionally omitted from snapshot output');
  assert.equal(scopes[0]!.item.sku, 'OLD');
  const r = reconcile({ ...scopes[0]!, policy: DEFAULT_POLICY, evaluatedAt });
  assert.equal(r.state, 'STALE');
  assert.ok(r.reasons.includes('COUNT_STALE'));
});
