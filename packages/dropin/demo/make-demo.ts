// builds a fictional store, a 3PL report in the 3PL's own format, and a cost list.
// every problem in it is planted on purpose; the comments say which.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShopifySnapshot } from '../src/shopify';

const here = fileURLToPath(new URL('.', import.meta.url));

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260922);
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const LEEDS = 'gid://shopify/Location/3001';
const SHOP = 'gid://shopify/Location/3002';
const REPORT_AT = '2026-09-22T06:00:00Z';
const FETCHED = '2026-09-22T18:00:00Z';

interface Sku {
  sku: string;
  product: string;
  variant: string;
  cost: number;
  count: number;
  weight: number;
  drift?: number;
  damaged?: number;
  tracked?: boolean;
}

// drift > 0: Shopify holds more than the evidence supports. drift < 0: less.
const skus: Sku[] = [
  { sku: 'DRY-5', product: 'Roll-top dry bag', variant: '5L', cost: 4.6, count: 180, weight: 5 },
  { sku: 'DRY-10', product: 'Roll-top dry bag', variant: '10L', cost: 6.1, count: 240, weight: 6, drift: 52 },
  { sku: 'DRY-20', product: 'Roll-top dry bag', variant: '20L', cost: 8.4, count: 120, weight: 3 },
  { sku: 'BTL-500', product: 'Steel bottle', variant: '500ml', cost: 4.1, count: 300, weight: 7 },
  { sku: 'BTL-750', product: 'Steel bottle', variant: '750ml', cost: 5.2, count: 260, weight: 8, drift: 31 },
  { sku: 'BTL-1L', product: 'Steel bottle', variant: '1L', cost: 6.3, count: 150, weight: 4 },
  { sku: 'TORCH-LITE', product: 'Head torch', variant: 'Lite', cost: 7.8, count: 140, weight: 4 },
  { sku: 'TORCH-PRO', product: 'Head torch', variant: 'Pro', cost: 14.9, count: 90, weight: 3, drift: 18 },
  { sku: 'SOCK-MOSS-S', product: 'Merino sock', variant: 'Moss / S', cost: 3.4, count: 200, weight: 4 },
  { sku: 'SOCK-MOSS-M', product: 'Merino sock', variant: 'Moss / M', cost: 3.4, count: 320, weight: 7, drift: 46 },
  { sku: 'SOCK-MOSS-L', product: 'Merino sock', variant: 'Moss / L', cost: 3.4, count: 210, weight: 4 },
  { sku: 'SOCK-SLATE-M', product: 'Merino sock', variant: 'Slate / M', cost: 3.4, count: 260, weight: 5 },
  { sku: 'BEAN-NAVY', product: 'Fern beanie', variant: 'Navy', cost: 4.1, count: 160, weight: 4, damaged: 3 },
  { sku: 'BEAN-MOSS', product: 'Fern beanie', variant: 'Moss', cost: 4.1, count: 130, weight: 3 },
  { sku: 'BEAN-EMBER', product: 'Fern beanie', variant: 'Ember', cost: 4.1, count: 110, weight: 3 },
  { sku: 'TEE-BLK-S', product: 'Heavyweight tee', variant: 'Black / S', cost: 6.4, count: 120, weight: 3 },
  { sku: 'TEE-BLK-M', product: 'Heavyweight tee', variant: 'Black / M', cost: 6.4, count: 210, weight: 6, drift: 14 },
  { sku: 'TEE-BLK-L', product: 'Heavyweight tee', variant: 'Black / L', cost: 6.4, count: 170, weight: 5 },
  { sku: 'TEE-BLK-XL', product: 'Heavyweight tee', variant: 'Black / XL', cost: 6.4, count: 90, weight: 2 },
  { sku: 'TEE-SND-M', product: 'Heavyweight tee', variant: 'Sand / M', cost: 6.4, count: 140, weight: 3 },
  { sku: 'TEE-SND-L', product: 'Heavyweight tee', variant: 'Sand / L', cost: 6.4, count: 130, weight: 3 },
  { sku: 'HOOD-GRY-M', product: 'Trail hoodie', variant: 'Grey / M', cost: 14.8, count: 80, weight: 3 },
  { sku: 'HOOD-GRY-L', product: 'Trail hoodie', variant: 'Grey / L', cost: 14.8, count: 95, weight: 3, drift: 14 },
  { sku: 'HOOD-GRY-XL', product: 'Trail hoodie', variant: 'Grey / XL', cost: 14.8, count: 60, weight: 2 },
  { sku: 'TOTE-NAT', product: 'Canvas tote', variant: 'Natural', cost: 2.9, count: 200, weight: 4 },
  { sku: 'TOTE-NAT', product: 'Canvas tote (old listing)', variant: 'Natural', cost: 2.9, count: 0, weight: 0 },
  { sku: 'MUG-WHT', product: 'Enamel mug', variant: 'White', cost: 3.2, count: 190, weight: 5, drift: -20 },
  { sku: 'MUG-GRN', product: 'Enamel mug', variant: 'Green', cost: 3.2, count: 150, weight: 4 },
  { sku: 'TWL-M', product: 'Trek towel', variant: 'M', cost: 7.2, count: 110, weight: 3 },
  { sku: 'TWL-L', product: 'Trek towel', variant: 'L', cost: 9.9, count: 100, weight: 3, drift: 11 },
  { sku: 'CARAB-2', product: 'Carabiner, 2 pack', variant: 'Default Title', cost: 2.1, count: 400, weight: 6, drift: 60 },
  { sku: 'FIRE-STL', product: 'Fire steel', variant: 'Default Title', cost: 3.3, count: 160, weight: 3, drift: -6 },
  { sku: 'STICK-PK', product: 'Sticker pack', variant: 'Default Title', cost: 0.35, count: 900, weight: 8 },
  { sku: 'MAP-LAKES', product: 'Waterproof map', variant: 'Lakes', cost: 2.8, count: 140, weight: 2 },
  { sku: 'MAP-PEAKS', product: 'Waterproof map', variant: 'Peaks', cost: 2.8, count: 120, weight: 2 },
  { sku: 'STOVE-1', product: 'Pocket stove', variant: 'Default Title', cost: 11.5, count: 70, weight: 2 },
  { sku: 'FUEL-230', product: 'Gas canister', variant: '230g', cost: 3.9, count: 220, weight: 4 },
  { sku: 'POLES-PR', product: 'Trek poles', variant: 'Pair', cost: 18.4, count: 45, weight: 1 },
  { sku: 'MAT-LITE', product: 'Sleeping mat', variant: 'Lite', cost: 16.2, count: 55, weight: 2 },
  { sku: 'LANT-MINI', product: 'Mini lantern', variant: 'Default Title', cost: 6.7, count: 100, weight: 2 },
  { sku: 'CAP-BLK', product: 'Trail cap', variant: 'Black', cost: 5.2, count: 12, weight: 0, tracked: false },
];

const itemId = (i: number) => `gid://shopify/InventoryItem/${900 + i}`;
const describe = (s: Sku) => (s.variant === 'Default Title' ? s.product : `${s.product} ${s.variant}`);

const sold = new Map<number, number>();
const stockIndex = skus.map((s, i) => i).filter((i) => skus[i]!.weight > 0);
const totalWeight = stockIndex.reduce((n, i) => n + skus[i]!.weight, 0);
const pick = () => {
  let r = rand() * totalWeight;
  for (const i of stockIndex) {
    r -= skus[i]!.weight;
    if (r <= 0) return i;
  }
  return stockIndex[0]!;
};
const stamp = (mins: number) => new Date(Date.parse('2026-09-22T00:00:00Z') + mins * 60000).toISOString().replace('.000Z', 'Z');

interface Order {
  id: string;
  name: string;
  createdAt: string;
  fulfillments: unknown[];
  refunds: unknown[];
}
const orders: Order[] = [];
const lastTouch = new Map<number, number>();
let fid = 5000;

for (let n = 0; n < 150; n++) {
  const created = between(6 * 60 + 20, 17 * 60 + 10);
  const lines: { i: number; q: number }[] = [];
  for (let k = between(1, 3); k > 0; k--) {
    const i = pick();
    const cap = Math.floor(skus[i]!.count * 0.3) - (sold.get(i) ?? 0);
    if (cap <= 0 || lines.some((l) => l.i === i)) continue;
    const q = Math.min(cap, between(1, 3));
    sold.set(i, (sold.get(i) ?? 0) + q);
    lines.push({ i, q });
  }
  if (!lines.length) continue;
  const shipped = Math.min(created + between(25, 110), 17 * 60 + 45);
  for (const l of lines) lastTouch.set(l.i, Math.max(lastTouch.get(l.i) ?? 0, shipped));
  fid++;
  orders.push({
    id: `gid://shopify/Order/${1100 + n}`,
    name: `#${1100 + n}`,
    createdAt: stamp(created),
    fulfillments: [
      {
        id: `gid://shopify/Fulfillment/${fid}`,
        status: 'SUCCESS',
        createdAt: stamp(shipped),
        updatedAt: stamp(shipped),
        locationId: LEEDS,
        lines: lines.map((l) => line(l.i, l.q)),
      },
    ],
    refunds: [],
  });
}

function line(i: number, quantity: number) {
  const s = skus[i]!;
  return { quantity, inventoryItemId: itemId(i), sku: s.sku, title: `${s.product} - ${s.variant}` };
}
const idx = (sku: string, product?: string) => skus.findIndex((s) => s.sku === sku && (!product || s.product === product));

// planted: a fulfilment still PENDING. whether the stock left is unknown to the feed.
const towel = idx('TWL-M');
orders.push({
  id: 'gid://shopify/Order/1290',
  name: '#1290',
  createdAt: stamp(14 * 60 + 40),
  fulfillments: [
    { id: 'gid://shopify/Fulfillment/5990', status: 'PENDING', createdAt: stamp(15 * 60 + 5), updatedAt: stamp(15 * 60 + 5), locationId: LEEDS, lines: [line(towel, 3)] },
  ],
  refunds: [],
});
lastTouch.set(towel, Math.max(lastTouch.get(towel) ?? 0, 15 * 60 + 5));

// planted: a refund restocked the old way, which does not say what physically came back
const mug = idx('MUG-GRN');
const refundOrder = orders[4]!;
refundOrder.refunds.push({
  id: 'gid://shopify/Refund/7100',
  createdAt: stamp(16 * 60 + 12),
  lines: [{ ...line(mug, 2), id: 'gid://shopify/RefundLineItem/7600', restockType: 'LEGACY_RESTOCK', restocked: true, locationId: LEEDS }],
});
lastTouch.set(mug, Math.max(lastTouch.get(mug) ?? 0, 16 * 60 + 12));

// planted: an order line with no product behind it
orders[9]!.fulfillments.push({
  id: 'gid://shopify/Fulfillment/5991',
  status: 'SUCCESS',
  createdAt: stamp(11 * 60 + 5),
  updatedAt: stamp(11 * 60 + 5),
  locationId: LEEDS,
  lines: [{ quantity: 2, inventoryItemId: null, sku: 'gift-wrap ', title: 'Gift wrap (manual)' }],
});

// planted: a transfer to the shop with three units rejected on receipt
const beanie = idx('BEAN-MOSS');
const transfers = [
  {
    id: 'gid://shopify/InventoryTransfer/61',
    name: '#T61',
    status: 'RECEIVED',
    originLocationId: LEEDS,
    destinationLocationId: SHOP,
    shipments: [
      {
        id: 'gid://shopify/InventoryShipment/71',
        status: 'RECEIVED',
        dateCreated: stamp(10 * 60 + 30),
        dateShipped: stamp(11 * 60),
        dateReceived: stamp(15 * 60),
        lines: [{ inventoryItemId: itemId(beanie), sku: 'BEAN-MOSS', quantity: 12, accepted: 9, rejected: 3, unreceived: 0 }],
      },
    ],
  },
];
lastTouch.set(beanie, Math.max(lastTouch.get(beanie) ?? 0, 11 * 60));

const reportRows: string[] = ['Item Code,Description,Qty On Hand,Qty Available,Warehouse,Report Date'];
const variants: ShopifySnapshot['variants'] = [];

skus.forEach((s, i) => {
  const out = sold.get(i) ?? 0;
  let bookSellable = s.count - out;
  if (i === towel) bookSellable -= 3;
  if (i === mug) bookSellable += 2;
  if (i === beanie) bookSellable -= 12;
  const damaged = s.damaged ?? 0;
  const drift = s.drift ?? 0;
  const book = bookSellable + drift + damaged;
  const touched = drift !== 0 ? Math.max(lastTouch.get(i) ?? 0, 13 * 60 + 15) : (lastTouch.get(i) ?? 6 * 60 - 5);
  const committed = s.tracked === false ? 0 : between(0, 4);

  const levels: ShopifySnapshot['variants'][number]['levels'] = [
    { locationId: LEEDS, onHand: book, available: book - committed - damaged, committed, damaged, qualityControl: 0, updatedAt: stamp(touched) },
  ];
  if (i === beanie) levels.push({ locationId: SHOP, onHand: 9, available: 9, committed: 0, damaged: 0, qualityControl: 0, updatedAt: stamp(15 * 60) });
  variants.push({
    variantId: `gid://shopify/ProductVariant/${800 + i}`,
    inventoryItemId: itemId(i),
    sku: s.sku,
    title: s.variant,
    productTitle: s.product,
    productStatus: 'ACTIVE',
    tracked: s.tracked !== false,
    levels: s.count === 0 && s.tracked !== false ? [{ locationId: LEEDS, onHand: 0, available: 0, committed: 0, damaged: 0, qualityControl: 0, updatedAt: stamp(5 * 60) }] : levels,
  });

  const second = s.sku === 'TOTE-NAT' && s.count === 0;
  if (!second) {
    reportRows.push(`${s.sku},"${describe(s)}",${s.count + damaged},${s.count},LEEDS,22/09/2026 07:00`);
  }
});

// planted: the 3PL holds stock Shopify has no variant for
reportRows.push('PIN-ENAMEL,Enamel pin badge,120,120,LEEDS,22/09/2026 07:00');

const snapshot: ShopifySnapshot = {
  shop: 'tern-and-co-demo.myshopify.com',
  apiVersion: '2026-07',
  fetchedAt: FETCHED,
  ordersSince: '2026-09-21T00:00:00Z',
  locations: [
    { id: LEEDS, name: 'Demo Fulfilment (3PL)', isActive: true },
    { id: SHOP, name: 'Studio shop', isActive: true },
  ],
  variants,
  orders: orders as ShopifySnapshot['orders'],
  transfers: transfers as NonNullable<ShopifySnapshot['transfers']>,
};

const costs = ['sku,cost', ...skus.filter((s, i) => skus.findIndex((x) => x.sku === s.sku) === i).map((s) => `${s.sku},${s.cost.toFixed(2)}`), 'PIN-ENAMEL,0.85'];

writeFileSync(join(here, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
writeFileSync(join(here, '3pl-report.csv'), reportRows.join('\n') + '\n');
writeFileSync(join(here, 'costs.csv'), costs.join('\n') + '\n');
console.log(`${variants.length} variants, ${orders.length} orders, ${reportRows.length - 1} report rows`);
