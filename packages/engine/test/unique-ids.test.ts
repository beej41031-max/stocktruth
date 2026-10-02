import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSuspectedDuplicateMovementGroups, type Movement } from '../src';

const at = (min: number) => new Date(Date.UTC(2026, 8, 22, 10, min));
const move = (id: string, min: number, over: Partial<Movement> = {}): Movement => ({
  id,
  type: 'ISSUE',
  quantity: 2,
  unit: 'each',
  occurredAt: at(min),
  recordedAt: at(min),
  importedAt: at(60),
  sourceSystemId: 'shopify',
  ...over,
});

test('without a guarantee, identical movements close together are still suspected', () => {
  const groups = findSuspectedDuplicateMovementGroups([move('a', 0), move('b', 3)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.movementIds, ['a', 'b']);
});

test('rows from one source that numbers its own events are distinct events', () => {
  const rows = [move('a', 0), move('b', 1), move('c', 2)].map((m) => ({ ...m, uniqueIdGuaranteed: true }));
  assert.equal(findSuspectedDuplicateMovementGroups(rows).length, 0);
});

test('the guarantee does not reach across sources', () => {
  const groups = findSuspectedDuplicateMovementGroups([
    move('a', 0, { uniqueIdGuaranteed: true }),
    move('b', 2, { uniqueIdGuaranteed: true, sourceSystemId: 'other-app' }),
  ]);
  assert.equal(groups.length, 1);
});

test('a guaranteed row next to an unguaranteed one is still suspected', () => {
  const groups = findSuspectedDuplicateMovementGroups([move('a', 0, { uniqueIdGuaranteed: true }), move('b', 2)]);
  assert.equal(groups.length, 1);
});

test('a source with no id at all gets no benefit of the doubt', () => {
  const rows = [move('a', 0, { sourceSystemId: null }), move('b', 2, { sourceSystemId: null })].map((m) => ({ ...m, uniqueIdGuaranteed: true }));
  assert.equal(findSuspectedDuplicateMovementGroups(rows).length, 1);
});

test('chains still group the way they did: a to b to c is one group', () => {
  const groups = findSuspectedDuplicateMovementGroups([move('a', 0), move('b', 4), move('c', 8)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.movementIds, ['a', 'b', 'c']);
});
