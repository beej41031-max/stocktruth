import { readFileSync } from 'node:fs';
import { parseCsv } from '@stocktruth/adapter-csv';

/**
 * A 3PL's stock report: what the warehouse holding the goods says it holds.
 *
 * Every 3PL exports something like this, usually daily. It is treated as the
 * observation because the 3PL has the goods; it is weaker than a blind count
 * by a person, and the count lines say who produced them so that is never
 * hidden.
 *
 * Expected columns: sku, quantity, as_of, and optionally warehouse (the 3PL's
 * own code for a site, mapped to a Shopify location by the caller).
 */
export interface ThreePlLine {
  sku: string;
  quantity: number;
  asOf: Date;
  warehouse: string | null;
  /** Row number in the file, for messages a person can act on. */
  row: number;
}

export interface ThreePlReport {
  /** Shown as the counter on every count line. */
  provider: string;
  /** Used as the count session id: one report, one session. */
  reportId: string;
  lines: ThreePlLine[];
}

export function readThreePlReport(path: string, provider: string, reportId?: string): ThreePlReport {
  return parseThreePlReport(readFileSync(path, 'utf8'), provider, reportId ?? path);
}

export function parseThreePlReport(text: string, provider: string, reportId: string): ThreePlReport {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  for (const required of ['sku', 'quantity', 'as_of']) {
    if (!header.includes(required)) throw new Error(`3PL report: missing column "${required}"`);
  }
  const col = (name: string) => header.indexOf(name);

  const lines = rows.map((r, i) => {
    const row = i + 2;
    const sku = (r[col('sku')] ?? '').trim();
    if (!sku) throw new Error(`3PL report row ${row}: empty sku`);

    const rawQty = (r[col('quantity')] ?? '').trim();
    const quantity = Number(rawQty);
    if (rawQty === '' || !Number.isFinite(quantity) || quantity < 0 || !Number.isInteger(quantity)) {
      throw new Error(`3PL report row ${row}: quantity "${rawQty}" is not a whole number of units`);
    }

    const rawDate = (r[col('as_of')] ?? '').trim();
    const asOf = new Date(rawDate);
    if (!rawDate || Number.isNaN(asOf.getTime())) {
      throw new Error(`3PL report row ${row}: as_of "${rawDate}" is not a date`);
    }
    // A report time without a zone would be read in whatever zone this
    // machine is in, which silently shifts every count by the UTC offset.
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(rawDate)) {
      throw new Error(`3PL report row ${row}: as_of "${rawDate}" has no timezone; add Z or an offset`);
    }

    const w = col('warehouse') >= 0 ? (r[col('warehouse')] ?? '').trim() : '';
    return { sku, quantity, asOf, warehouse: w || null, row };
  });

  return { provider, reportId, lines };
}
