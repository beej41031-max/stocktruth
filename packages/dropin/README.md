# Drop-in

Shopify's stock figure against a 3PL's stock report, in one HTML file.

    npm run build:dropin     # writes stocktruth-dropin.html at the top of the repository
    npm run demo-data --workspace packages/dropin   # rebuilds the demo store

Open the file in a browser. It needs no server and makes no network requests:
the page carries a content security policy of `default-src 'none'`, so the
browser itself refuses any request. The "Try to send something" link at the top
makes a real attempt and shows the browser's refusal.

## What goes in

1. A Shopify snapshot (`snapshot.json`), the file the Shopify adapter saves with
   `SAVE_SNAPSHOT`. Orders in it must reach back before the 3PL report was taken.
2. The 3PL's stock report as CSV. Column names, delimiter, date order and time
   zone are guessed and can be changed. Files with no time column take a report
   time. Total rows are skipped. A SKU on more than one row is refused unless
   you say the rows are lots or bins.
3. Optionally, unit costs: a two-column paste, or a Shopify product export
   (`Variant SKU`, `Cost per item`). With no costs, everything is in units. With
   only selling prices, values are labelled "at selling price".

## What comes out

- Two figures, never netted against each other: what Shopify holds above the
  evidence, and below it. A gap is only priced if the engine could size it.
- Questions, biggest first. One question covers every SKU that waits on it, and
  carries the pounds that ride on its answer.
- A case file per SKU: the 3PL count walked forward through every shipment and
  return Shopify recorded, against Shopify's own figure.
- An evidence pack for the 3PL (prints to PDF, copies as a message), and a CSV.

## Answers

The engine refuses to blame either side of a gap, because Shopify's API cannot
show manual adjustments. A person can know what the API cannot. Three answers
are accepted:

- nothing was changed by hand at a location since the report
- a stated number of units was added or removed by hand (and nothing else, or not).
  The answer carries no time, because the person did not give one. It is applied
  to the position and to the gap as a change somewhere between the count and
  Shopify's figure, drawn as a span over that interval and never as a point.
- an adjustment with no direction went in, went out, or moved nothing

Each answer is applied by re-running the engine with different evidence, never
by editing a result. Every figure that depends on one is marked "on your word",
the evidence pack lists the answers with their notes, and any answer can be taken
back. See decision 0026.

## Not here

There is no route from Shopify's own CSV exports. A day's sales would read as
loss unless orders are carried forward with it, and the exports do not carry
fulfilment times reliably enough to do that honestly. The snapshot route is the
validated one.

The demo store is invented. Every problem in it is planted and listed at the top
of `demo/make-demo.ts`.

## Testing it on a real store

Take the snapshot with the Shopify adapter's live run (read-only; it refuses any
mutation in code):

    SHOPIFY_SHOP=your-store SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... \
    THREEPL_REPORT=./report.csv THREEPL_LOCATIONS="CODE=gid://shopify/Location/123" \
    ORDERS_SINCE=<a day before the report was taken> SAVE_SNAPSHOT=snapshot.json \
    npm run demo --workspace packages/adapter-shopify

Then open the built page and drop in `snapshot.json`, the same report CSV, and
(optionally) a cost file. Check the line under the file boxes that says how the
3PL file was read: SKU column, quantity column, whether it is on-hand or sellable
stock, and the zone its times are on. A wrong zone shifts the count by the offset
and turns every sale in the gap into apparent loss.
