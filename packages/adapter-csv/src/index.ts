import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MOVEMENT_SIGN,
  type EvidenceSource,
  type ItemRef,
  type Movement,
  type MovementType,
  type ReconciliationPolicy,
  type ScopeEvidence,
  type ScopeRef,
  type SiteRef,
} from '@stocktruth/engine';

export interface CsvAdapterOptions {
  /** When this snapshot entered the reasoning system. Fixed in tests/demos. */
  receivedAt?: Date;
}

/**
 * A deliberately small second EvidenceSource: four ordinary CSV exports, no
 * database and no shared schema with the Postgres host. It exists to prove the
 * engine port is a real boundary rather than a Postgres-shaped abstraction.
 *
 * The adapter is intentionally snapshot-only. It does not pretend it can
 * answer "what did we know last Tuesday?" because a flat export does not carry
 * that history; supportsKnownAt says so explicitly.
 */
export class CsvEvidenceSource implements EvidenceSource {
  readonly supportsKnownAt = false;
  readonly adapterName = 'csv-export';

  private readonly items: ItemRef[];
  private readonly book = new Map<string, ScopeEvidence['book']>();
  private readonly counts = new Map<string, ScopeEvidence['count']>();
  private readonly movements = new Map<string, Movement[]>();
  private readonly unlinkedCount: number;

  constructor(dir: string, options: CsvAdapterOptions = {}) {
    const receivedAt = options.receivedAt ?? new Date();
    assertValidDate(receivedAt, 'adapter receivedAt');

    const itemRows = readCsv(join(dir, 'items.csv'), ['id', 'name', 'unit', 'active', 'blocked']);
    const bookRows = readCsv(join(dir, 'book.csv'), ['item_id', 'quantity', 'unit', 'as_of']);
    const countRows = readCsv(join(dir, 'counts.csv'), ['item_id', 'quantity', 'unit', 'counted_at']);
    const moveRows = readCsv(join(dir, 'movements.csv'), [
      'item_id', 'type', 'quantity', 'unit', 'occurred_at', 'recorded_at',
    ]);

    this.items = itemRows.map((r, index) => ({
      id: required(r, 'id', 'items.csv', index),
      sku: optional(r.sku),
      name: required(r, 'name', 'items.csv', index),
      stockUnit: required(r, 'unit', 'items.csv', index),
      active: booleanCell(r.active, 'active', 'items.csv', index),
      blocked: booleanCell(r.blocked, 'blocked', 'items.csv', index),
      blockedReason: optional(r.blocked_reason),
    }));

    const ids = new Set<string>();
    for (const item of this.items) {
      if (ids.has(item.id)) throw new Error(`items.csv: duplicate item id ${item.id}`);
      ids.add(item.id);
    }

    // Duplicate business codes are not two harmless scopes: any external row
    // keyed by that code is ambiguous. Preserve both items, but mark both as
    // unsafe so the engine returns AMBIGUOUS_ITEM_IDENTITY instead of a number.
    const skuOwners = new Map<string, ItemRef[]>();
    for (const item of this.items) {
      if (!item.sku) continue;
      const key = item.sku.trim().toUpperCase();
      const owners = skuOwners.get(key) ?? [];
      owners.push(item);
      skuOwners.set(key, owners);
    }
    for (const owners of skuOwners.values()) {
      if (owners.length < 2) continue;
      for (const item of owners) item.identityAmbiguous = true;
    }

    for (const [index, r] of bookRows.entries()) {
      const itemId = required(r, 'item_id', 'book.csv', index);
      this.book.set(itemId, {
        id: `book-${itemId}`,
        quantity: numberCell(r.quantity, 'quantity', 'book.csv', index),
        unit: required(r, 'unit', 'book.csv', index),
        asOf: optionalDate(r.as_of, 'as_of', 'book.csv', index),
        sourceSystemId: 'csv-export',
      });
    }

    for (const [index, r] of countRows.entries()) {
      const itemId = required(r, 'item_id', 'counts.csv', index);
      const countedAt = requiredDate(r.counted_at, 'counted_at', 'counts.csv', index);
      this.counts.set(itemId, {
        id: `count-${itemId}`,
        quantity: numberCell(r.quantity, 'quantity', 'counts.csv', index),
        unit: required(r, 'unit', 'counts.csv', index),
        countedAt,
        // Snapshot CSV cannot distinguish device time from upload time. Rather
        // than invent a second timestamp, keep both at the observation time.
        receivedAt: countedAt,
        countedBy: optional(r.counted_by),
        sessionId: 'csv-import',
        sessionWatermark: null,
      });
    }

    let unlinked = 0;
    for (const [index, r] of moveRows.entries()) {
      const itemId = required(r, 'item_id', 'movements.csv', index);
      const type = movementType(r.type, 'movements.csv', index);
      const movement: Movement = {
        id: `csv-movement-${index + 1}`,
        type,
        quantity: nonNegativeNumberCell(r.quantity, 'quantity', 'movements.csv', index),
        unit: required(r, 'unit', 'movements.csv', index),
        occurredAt: optionalDate(r.occurred_at, 'occurred_at', 'movements.csv', index),
        recordedAt: optionalDate(r.recorded_at, 'recorded_at', 'movements.csv', index),
        importedAt: receivedAt,
        sourceSystemId: 'csv-export',
      };

      if (!ids.has(itemId)) {
        unlinked++;
        continue;
      }
      const list = this.movements.get(itemId) ?? [];
      list.push(movement);
      this.movements.set(itemId, list);
    }
    this.unlinkedCount = unlinked;
  }

  async loadPolicy(_site: SiteRef): Promise<Partial<ReconciliationPolicy>> {
    return {};
  }

  async listScopes(site: SiteRef): Promise<ScopeRef[]> {
    return (await this.loadSite(site)).map((s) => ({ itemId: s.item.id, locationId: null }));
  }

  async loadScope(_site: SiteRef, scope: ScopeRef): Promise<ScopeEvidence | null> {
    const item = this.items.find((candidate) => candidate.id === scope.itemId);
    if (!item || !item.active) return null;
    return {
      item,
      locationId: null,
      book: this.book.get(item.id) ?? null,
      count: this.counts.get(item.id) ?? null,
      movements: this.movements.get(item.id) ?? [],
      unlinkedMovementCount: this.unlinkedCount,
      possiblyRelatedUnlinkedCount: 0,
      sources: [],
    };
  }

  async loadSite(site: SiteRef): Promise<ScopeEvidence[]> {
    const scopes = await Promise.all(
      this.items.filter((item) => item.active).map((item) =>
        this.loadScope(site, { itemId: item.id, locationId: null }),
      ),
    );
    return scopes.filter((scope): scope is ScopeEvidence => scope != null);
  }
}

function readCsv(path: string, requiredHeaders: string[]): Record<string, string>[] {
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (rows.length === 0) throw new Error(`${path}: empty CSV`);
  const headers = rows[0]!;
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`${path}: missing columns ${missing.join(', ')}`);

  return rows.slice(1)
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ''])));
}

/** Small RFC4180-style parser: quoted commas/newlines and doubled quotes work. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }

  if (quoted) throw new Error('CSV ended inside a quoted field');
  if (cell.length || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function required(row: Record<string, string>, key: string, file: string, index: number): string {
  const value = row[key]?.trim();
  if (!value) throw new Error(`${file} row ${index + 2}: ${key} is required`);
  return value;
}

function numberCell(value: string | undefined, key: string, file: string, index: number): number {
  const raw = value?.trim() ?? '';
  const parsed = Number(raw);
  if (raw === '' || !Number.isFinite(parsed)) {
    throw new Error(`${file} row ${index + 2}: ${key} must be a finite number`);
  }
  return parsed;
}

function nonNegativeNumberCell(value: string | undefined, key: string, file: string, index: number): number {
  const parsed = numberCell(value, key, file, index);
  if (parsed < 0) {
    throw new Error(`${file} row ${index + 2}: ${key} must be non-negative; direction belongs in type`);
  }
  return parsed;
}

function booleanCell(value: string | undefined, key: string, file: string, index: number): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${file} row ${index + 2}: ${key} must be true or false`);
}

function optionalDate(value: string | undefined, key: string, file: string, index: number): Date | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  return requiredDate(raw, key, file, index);
}

function requiredDate(value: string | undefined, key: string, file: string, index: number): Date {
  const raw = value?.trim() ?? '';
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.getTime())) {
    throw new Error(`${file} row ${index + 2}: ${key} must be an ISO date/time`);
  }
  return parsed;
}

function assertValidDate(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) throw new Error(`${label} must be a valid date`);
}

function movementType(value: string | undefined, file: string, index: number): MovementType {
  const type = value?.trim() as MovementType | undefined;
  if (!type || !(type in MOVEMENT_SIGN)) {
    throw new Error(`${file} row ${index + 2}: unsupported movement type ${value ?? '(blank)'}`);
  }
  return type;
}
