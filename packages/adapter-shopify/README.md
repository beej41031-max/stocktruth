# @stocktruth/adapter-shopify

Checks a Shopify store's stock figures against a 3PL's stock report, through
the StockTruth engine. Read-only.

```text
Shopify on_hand ─── book
3PL stock report ── count          ──►  engine  ──►  stated / refused + why
fulfilments, restocked refunds ── movements
```

For each variant at each location it answers: does Shopify's figure agree with
what the warehouse reported this morning, carried forward through everything
Shopify shipped and took back since? If not, by how much, and can the gap be
blamed on either side?

## Run the demo

```bash
npm run demo:shopify        # from the repo root
```

The demo store in `examples/fixture` has one planted problem per SKU. Each is
asserted in `test/adapter.test.ts`.

## Run it against a real store

1. **The store owner creates the app, not you.** Since January 2026 Shopify
   no longer allows new custom apps to be made in the store admin. The owner
   opens the [Dev Dashboard](https://dev.shopify.com/dashboard/), creates an
   app, gives its version these scopes and nothing else: `read_products`,
   `read_inventory`, `read_locations`, `read_orders`,
   `read_inventory_transfers`, `read_inventory_shipments` (plus
   `read_all_orders` only if the order window is over 59 days). Orders count
   as protected customer data even without names or addresses, so the app must
   also declare protected customer data use; the lowest, non-identifying tier
   is enough, because no query here reads a customer's name, email or
   address. Then install it on the store and share the **Client ID** and
   **Client secret** from the app's Settings.
   This has to happen in the owner's organisation: Shopify refuses the
   credential exchange (`shop_not_permitted`) when the app and the store belong
   to different organisations. For your own testing, create the dev store from
   the Dev Dashboard's **Dev stores** page for the same reason.
   An existing admin-created app's token still works: pass
   `SHOPIFY_ADMIN_TOKEN` instead.
2. Get the 3PL's stock report as CSV with columns `sku, quantity, as_of,
   warehouse`. `as_of` must carry a timezone (`Z` or an offset).
3. Find the Shopify location id for each 3PL warehouse code (the demo prints
   them; they look like `gid://shopify/Location/123`).

```bash
SHOPIFY_SHOP=your-store \
SHOPIFY_CLIENT_ID=... \
SHOPIFY_CLIENT_SECRET=... \
THREEPL_REPORT=./report.csv \
THREEPL_PROVIDER="Your 3PL" \
THREEPL_LOCATIONS="LEEDS=gid://shopify/Location/123" \
THREEPL_BASIS=sellable \
ORDERS_SINCE=2026-09-21T00:00:00Z \
SAVE_SNAPSHOT=./snapshot.json \
npm run demo:shopify
```

Ask the 3PL what their quantity includes. `THREEPL_BASIS=sellable` compares
against Shopify's on-hand minus damaged and quality-control stock; leave it
out if the report counts everything physically there. The demo output flags
likely mismatches either way.

Tokens from the credentials last 24 hours and are refreshed automatically.
`ORDERS_SINCE` must be before the report's `as_of`; windows over 59 days are
refused unless `READ_ALL_ORDERS=1` confirms the scope, because without it
Shopify silently returns only 60 days. `SAVE_SNAPSHOT` writes what
was read, so a run can be replayed and tested offline.

The client refuses to send any mutation, checked before a request is built
(`src/client.ts`, `assertReadOnly`). Nothing in this package can change a store.

## How Shopify records are read

| Shopify | Becomes | Why |
|---|---|---|
| `on_hand` at a location | book | Includes units committed to unshipped orders: they are still on the shelf. `available` would read every open order as missing stock. |
| fulfilment, `SUCCESS` | ISSUE | Stock left the building. |
| fulfilment, `CANCELLED` | ISSUE plus its reversal | Left and came back. Both rows kept; the engine nets them. |
| fulfilment, any other status | ADJUST (blocks) | Stock may or may not have left. |
| refund restocked as `RETURN` | RETURN | Goods came back. |
| refund restocked as `CANCEL` | nothing | It never shipped. On-hand did not change; counting it would invent stock. |
| refund `NO_RESTOCK` | nothing | Customer kept it, or it was written off. |
| refund `LEGACY_RESTOCK` | ADJUST (blocks) | Predates Shopify recording which kind of restock it was. |
| line with no product behind it | unlinked movement | Custom line items and deleted variants. If its SKU matches a real variant, that variant is blocked: it may be the same goods. |
| transfer shipment, shipped | TRANSFER_OUT at the origin | Origin on-hand falls when it leaves, received or not. |
| transfer shipment, received | TRANSFER_IN of accepted units only | Rejected units left the origin and arrived nowhere; they are listed as a finding. With no origin, it is a RECEIVE. |
| transfer draft or ready to ship | nothing | A hold: committed at the origin, on-hand unchanged. |
| damaged / quality control | inside on-hand | Subtracted when `THREEPL_BASIS=sellable`. |
| two variants sharing a SKU | both ambiguous | A report keyed by SKU cannot tell them apart. |
| variant not tracked | finding, not a scope | Shopify has no figure to check. If the 3PL holds it, Shopify can sell it without limit. |

## What it cannot see

Shopify's Admin API has no query for the history of manual inventory
adjustments. Receipts entered by hand, stocktake corrections and changes made
by other apps are invisible to it. So every scope is marked
`movementFeedComplete: false`, and:

- when Shopify agrees with the evidence, the result is `PROVISIONAL`, never
  `VERIFIED`;
- when it disagrees, the gap is reported (`varianceAtCount`) but the position
  is refused with `BOOK_GAP_UNATTRIBUTABLE`, because an unseen receipt and real
  loss look the same from here.

See `docs/decisions/0025`.

Locations are read with `includeLegacy: true`: 3PLs connected as
fulfilment services otherwise hold stock at a location the ordinary query
does not list.

Transfers have one timing blind spot. Shopify records only when a shipment
was first received, so if units arrive in two batches either side of the 3PL
report, the later batch cannot be placed in time. That case comes out as a
refused gap, never as agreement (tested); a single-batch receipt, partial or
full, is exact.

Also not handled yet: bundles and kits, stores with more than 20 locations per
item, orders with 10 or more fulfilments or refunds, and more than 25 lines on
one fulfilment or refund. Each of those is refused with an error rather than
read partially. Large catalogues will be slow: pages are small to stay under
Shopify's query cost limit, and bulk export is the next step.
