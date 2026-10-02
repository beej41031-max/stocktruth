import type { ThreePlLine, ThreePlReport } from './shopify';
import { findColumn, norm, type Table } from './csv';

export class ReportError extends Error {}

const SKU = ['sku', 'item', 'item code', 'item sku', 'product code', 'product sku', 'variant sku', 'part number', 'part no', 'stock code', 'article', 'code'];
const QTY_ON_HAND = ['on hand', 'onhand', 'qty on hand', 'quantity on hand', 'physical', 'physical stock', 'total', 'quantity', 'qty', 'stock', 'stock level', 'units'];
const QTY_SELLABLE = ['sellable', 'available', 'qty available', 'quantity available', 'free stock', 'available stock'];
const AS_OF = ['as of', 'as at', 'report date', 'snapshot time', 'snapshot', 'stock date', 'run date', 'generated', 'timestamp', 'datetime', 'date time', 'date'];
const WAREHOUSE = ['warehouse', 'warehouse code', 'site', 'site code', 'location', 'depot', 'facility'];

export interface Guess {
  sku: number;
  quantity: number[];
  asOf: number;
  warehouse: number;
}

export function guessColumns(headers: string[]): Guess {
  const quantity: number[] = [];
  for (const names of [QTY_ON_HAND, QTY_SELLABLE]) {
    const i = findColumn(headers, names);
    if (i >= 0 && !quantity.includes(i)) quantity.push(i);
  }
  headers.forEach((h, i) => {
    if (/\b(qty|quantity)\b/.test(norm(h)) && !quantity.includes(i)) quantity.push(i);
  });
  return {
    sku: findColumn(headers, SKU),
    quantity,
    asOf: findColumn(headers, AS_OF),
    warehouse: findColumn(headers, WAREHOUSE),
  };
}

export function looksSellable(header: string): boolean {
  return QTY_SELLABLE.map(norm).includes(norm(header));
}

function offsetMinutes(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60000);
}

// wall-clock time in a named zone to a real instant. the second pass matters
// within an hour of a clock change.
export function zonedToDate(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let at = guess - offsetMinutes(guess, zone) * 60000;
  const again = offsetMinutes(at, zone);
  at = guess - again * 60000;
  return new Date(at);
}

export interface WhenOptions {
  zone: string;
  dayFirst: boolean;
  // 'HH:mm', for files that only carry a date
  timeOfDay: string | null;
}

export type When = { at: Date } | { error: string };

export function parseWhen(raw: string, o: WhenOptions): When {
  const text = raw.trim();
  if (!text) return { error: 'is empty' };

  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const fixed = text.replace(' ', 'T').replace(/\s+/g, '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const at = new Date(fixed);
    return Number.isNaN(at.getTime()) ? { error: 'is not a date' } : { at };
  }

  let y: number, mo: number, d: number, rest: string[];
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    rest = [iso[4] ?? '', iso[5] ?? '', iso[6] ?? ''];
  } else if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    [d, mo] = o.dayFirst ? [a, b] : [b, a];
    y = Number(dmy[3]);
    if (y < 100) y += 2000;
    rest = [dmy[4] ?? '', dmy[5] ?? '', dmy[6] ?? ''];
  } else return { error: 'is not a date this reader knows (use 2026-09-22 06:00, or 22/09/2026 06:00)' };

  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { error: 'has a day or month out of range, check the day/month order' };

  let h = rest[0] === '' ? null : Number(rest[0]);
  let mi = rest[1] === '' ? null : Number(rest[1]);
  const s = rest[2] === '' ? 0 : Number(rest[2]);
  if (h == null || mi == null) {
    if (!o.timeOfDay) return { error: 'has a date but no time of day; say when the report was run' };
    const [th, tm] = o.timeOfDay.split(':').map(Number);
    h = th ?? 0;
    mi = tm ?? 0;
  }
  return { at: zonedToDate(y, mo, d, h, mi, s, o.zone) };
}

function parseQuantity(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, '');
  if (!/^-?\d{1,3}(,\d{3})+(\.0+)?$|^-?\d+(\.0+)?$/.test(t)) return null;
  return Number(t.replace(/,/g, ''));
}

export interface ReportOptions {
  skuCol: number;
  qtyCol: number;
  asOfCol: number | null;
  warehouseCol: number | null;
  zone: string;
  dayFirst: boolean;
  // 'YYYY-MM-DDTHH:mm' on the 3PL's wall clock, for files with no time column
  reportTime: string | null;
  sumDuplicates: boolean;
}

export function buildReport(table: Table, o: ReportOptions, provider: string, reportId: string): { report: ThreePlReport; notes: string[] } {
  const notes: string[] = [];
  const problems: string[] = [];
  const lines: ThreePlLine[] = [];

  const [reportDay, reportClock] = (o.reportTime ?? '').split('T');
  const timeOfDay = reportClock ?? null;
  const fallback = (): When => {
    if (!o.reportTime) return { error: 'has no time; say when the report was run' };
    const [y, m, d] = (reportDay ?? '').split('-').map(Number);
    const [h, mi] = (reportClock ?? '').split(':').map(Number);
    if (!y || !m || !d || h == null || mi == null) return { error: 'report time is not complete' };
    return { at: zonedToDate(y, m, d, h, mi, 0, o.zone) };
  };

  let skippedTotals = 0;
  table.rows.forEach((r, i) => {
    const row = i + 2;
    const sku = (r[o.skuCol] ?? '').trim();
    if (/^(grand )?total$/i.test(sku)) {
      skippedTotals++;
      return;
    }
    if (!sku) {
      problems.push(`row ${row}: the SKU is empty`);
      return;
    }
    const rawQty = r[o.qtyCol] ?? '';
    const quantity = parseQuantity(rawQty);
    if (quantity == null || quantity < 0) {
      problems.push(`row ${row}: quantity "${rawQty.trim()}" is not a whole number of units`);
      return;
    }
    let when: When;
    const rawWhen = o.asOfCol == null ? '' : (r[o.asOfCol] ?? '');
    if (o.asOfCol == null || rawWhen.trim() === '') when = fallback();
    else when = parseWhen(rawWhen, { zone: o.zone, dayFirst: o.dayFirst, timeOfDay });
    if ('error' in when) {
      problems.push(`row ${row}: the time "${rawWhen.trim()}" ${when.error}`);
      return;
    }
    const w = o.warehouseCol == null ? '' : (r[o.warehouseCol] ?? '').trim();
    lines.push({ sku, quantity, asOf: when.at, warehouse: w || null, row });
  });

  if (problems.length) {
    const shown = problems.slice(0, 5).join('; ');
    const more = problems.length > 5 ? `; and ${problems.length - 5} more` : '';
    throw new ReportError(`The 3PL file has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${shown}${more}.`);
  }
  if (!lines.length) throw new ReportError('The 3PL file has no stock rows.');
  if (skippedTotals) notes.push(`Skipped ${skippedTotals} total row${skippedTotals === 1 ? '' : 's'}.`);

  const seen = new Map<string, ThreePlLine>();
  const merged: ThreePlLine[] = [];
  let summed = 0;
  for (const l of lines) {
    const key = `${l.warehouse ?? ''}|${l.sku.trim().toUpperCase().replace(/\s+/g, '')}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, l);
      merged.push(l);
      continue;
    }
    if (!o.sumDuplicates) {
      throw new ReportError(`${l.sku} is on rows ${first.row} and ${l.row}. If these are lots or bins, choose "add them up".`);
    }
    if (first.asOf.getTime() !== l.asOf.getTime()) {
      throw new ReportError(`${l.sku} is on rows ${first.row} and ${l.row} with different times, so they cannot be added up.`);
    }
    first.quantity += l.quantity;
    summed++;
  }
  if (summed) notes.push(`Added up ${summed} extra row${summed === 1 ? '' : 's'} for SKUs that appeared more than once (lots or bins).`);

  return { report: { provider, reportId, lines: merged }, notes };
}
