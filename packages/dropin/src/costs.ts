import { findColumn, readTable } from './csv';

export interface Unit {
  cost: number | null;
  price: number | null;
}

const SKU = ['sku', 'variant sku', 'item', 'item code', 'product code', 'code'];
const COST = ['cost', 'unit cost', 'cost per item', 'cost price', 'landed cost', 'buy price'];
const PRICE = ['price', 'variant price', 'selling price', 'sell price', 'retail price', 'rrp'];

export function parseMoney(raw: string): number | null {
  let t = raw.trim().replace(/[^\d.,-]/g, '');
  if (!t) return null;
  if (/^-?\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function normSku(sku: string): string {
  return sku.trim().toUpperCase().replace(/\s+/g, '');
}

export function readCosts(text: string): { units: Map<string, Unit>; note: string } {
  const table = readTable(text);
  let skuCol = findColumn(table.headers, SKU);
  let costCol = findColumn(table.headers, COST);
  const priceCol = findColumn(table.headers, PRICE);
  let rows = table.rows;

  // a bare two-column paste with no header row
  if (skuCol < 0 && costCol < 0 && priceCol < 0 && table.headers.length >= 2) {
    const second = table.headers[1] ?? '';
    if (parseMoney(second) != null) {
      rows = [table.headers, ...table.rows];
      skuCol = 0;
      costCol = 1;
    }
  }
  if (skuCol < 0 || (costCol < 0 && priceCol < 0)) {
    throw new Error('The cost file needs a SKU column and a cost or price column.');
  }

  const units = new Map<string, Unit>();
  for (const r of rows) {
    const sku = (r[skuCol] ?? '').trim();
    if (!sku) continue;
    const cost = costCol >= 0 ? parseMoney(r[costCol] ?? '') : null;
    const price = priceCol >= 0 ? parseMoney(r[priceCol] ?? '') : null;
    if (cost == null && price == null) continue;
    const key = normSku(sku);
    const have = units.get(key);
    units.set(key, { cost: cost ?? have?.cost ?? null, price: price ?? have?.price ?? null });
  }
  const withCost = [...units.values()].filter((u) => u.cost != null).length;
  const note = costCol >= 0 ? `${withCost} SKUs with a cost` : `${units.size} SKUs with a selling price, no costs`;
  return { units, note };
}
