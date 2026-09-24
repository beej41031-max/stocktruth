import { ShopifyAdminClient, ShopifyError } from './client';
import type {
  ShopifyFulfillment,
  ShopifyLine,
  ShopifyLocation,
  ShopifyOrder,
  ShopifyRefund,
  ShopifySnapshot,
  ShopifyTransfer,
  ShopifyVariant,
} from './snapshot';

/**
 * Reads a store into a snapshot. Paginated queries rather than bulk
 * operations: slower on a big catalogue, but every page is a plain request
 * that can be recorded and replayed in tests. Bulk export is the next step for
 * stores with tens of thousands of variants.
 */

const LOCATIONS = /* GraphQL */ `
  query StockTruthLocations($first: Int!, $cursor: String) {
    locations(first: $first, after: $cursor, includeInactive: true, includeLegacy: true) {
      pageInfo { hasNextPage endCursor }
      nodes { id name isActive }
    }
  }
`;

const VARIANTS = /* GraphQL */ `
  query StockTruthVariants($first: Int!, $cursor: String) {
    productVariants(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        title
        product { title status }
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 20) {
            pageInfo { hasNextPage }
            nodes {
              updatedAt
              location { id }
              quantities(names: ["on_hand", "available", "committed", "damaged", "quality_control"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;

const ORDERS = /* GraphQL */ `
  query StockTruthOrders($first: Int!, $cursor: String, $query: String!) {
    orders(first: $first, after: $cursor, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        fulfillments(first: 10) {
          id
          status
          createdAt
          updatedAt
          location { id }
          fulfillmentLineItems(first: 25) {
            pageInfo { hasNextPage }
            nodes { quantity lineItem { sku title variant { inventoryItem { id } } } }
          }
        }
        refunds(first: 10) {
          id
          createdAt
          refundLineItems(first: 25) {
            pageInfo { hasNextPage }
            nodes {
              id
              quantity
              restockType
              restocked
              location { id }
              lineItem { sku title variant { inventoryItem { id } } }
            }
          }
        }
      }
    }
  }
`;

const TRANSFERS = /* GraphQL */ `
  query StockTruthTransfers($first: Int!, $cursor: String) {
    inventoryTransfers(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        status
        origin { location { id } }
        destination { location { id } }
        shipments(first: 10) {
          pageInfo { hasNextPage }
          nodes {
            id
            status
            dateCreated
            dateShipped
            dateReceived
            lineItems(first: 50) {
              pageInfo { hasNextPage }
              nodes {
                quantity
                acceptedQuantity
                rejectedQuantity
                unreceivedQuantity
                inventoryItem { id sku }
              }
            }
          }
        }
      }
    }
  }
`;

export interface FetchOptions {
  /** Orders updated at or after this instant are read. Must predate the 3PL report. */
  ordersSince: Date;
  /** Fixed in tests. */
  now?: () => Date;
  /** Called once per page, for progress output. */
  onPage?: (what: string, count: number) => void;
  /**
   * Confirms the app has read_all_orders. Without it Shopify returns only the
   * last 60 days of orders and says nothing about the rest, so a longer
   * window is refused unless this is set.
   */
  readAllOrdersGranted?: boolean;
}

export async function fetchShopifySnapshot(
  client: ShopifyAdminClient,
  options: FetchOptions,
): Promise<ShopifySnapshot> {
  const now = options.now ?? (() => new Date());
  const since = options.ordersSince.toISOString();
  const windowDays = (now().getTime() - options.ordersSince.getTime()) / 86_400_000;
  if (windowDays > 59 && !options.readAllOrdersGranted) {
    throw new ShopifyError(
      `Orders are wanted from ${Math.floor(windowDays)} days ago, but without the read_all_orders scope Shopify ` +
        'returns only the last 60 days and gives no sign the rest are missing. Grant the scope and pass ' +
        'readAllOrdersGranted, or use a report taken within the last 59 days.',
      'WINDOW',
    );
  }

  const locations = await paginate<RawLocation>(client, LOCATIONS, 'locations', {}, 100, options.onPage);
  const variants = await paginate<RawVariant>(client, VARIANTS, 'productVariants', {}, 25, options.onPage);
  const orders = await paginate<RawOrder>(
    client,
    ORDERS,
    'orders',
    { query: `updated_at:>='${since}'` },
    5,
    options.onPage,
  );

  const transfers = await paginate<RawTransfer>(client, TRANSFERS, 'inventoryTransfers', {}, 10, options.onPage);

  // Taken after the reads, so no row in the snapshot is newer than its own
  // knowledge clock.
  const fetchedAt = now().toISOString();

  return {
    shop: client.shop,
    apiVersion: client.apiVersion,
    fetchedAt,
    ordersSince: since,
    locations: locations.map(toLocation),
    variants: variants.map(toVariant),
    orders: orders.map(toOrder),
    transfers: transfers.map(toTransfer),
  };
}

async function paginate<T>(
  client: ShopifyAdminClient,
  document: string,
  root: string,
  variables: Record<string, unknown>,
  pageSize: number,
  onPage?: (what: string, count: number) => void,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  let first = pageSize;

  for (;;) {
    let data: Record<string, RawConnection<T>>;
    try {
      data = await client.query<Record<string, RawConnection<T>>>(document, { ...variables, first, cursor });
    } catch (err) {
      // Shopify prices a query by its page sizes. Too expensive: ask for less.
      if (err instanceof ShopifyError && err.code === 'MAX_COST_EXCEEDED' && first > 1) {
        first = Math.max(1, Math.floor(first / 2));
        continue;
      }
      throw err;
    }
    const conn = data[root];
    if (!conn) throw new ShopifyError(`Response had no "${root}"`, 'SHAPE');
    out.push(...conn.nodes);
    onPage?.(root, out.length);
    if (!conn.pageInfo.hasNextPage) return out;
    cursor = conn.pageInfo.endCursor;
  }
}

// --- raw response shapes -----------------------------------------------------

interface RawConnection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

interface RawLocation {
  id: string;
  name: string;
  isActive: boolean;
}

interface RawVariant {
  id: string;
  sku: string | null;
  title: string;
  product: { title: string; status: string };
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevels: {
      pageInfo: { hasNextPage: boolean };
      nodes: {
        updatedAt: string;
        location: { id: string };
        quantities: { name: string; quantity: number }[];
      }[];
    };
  };
}

interface RawLineItem {
  sku: string | null;
  title: string;
  variant: { inventoryItem: { id: string } | null } | null;
}

interface RawOrder {
  id: string;
  name: string;
  createdAt: string;
  fulfillments: {
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    location: { id: string } | null;
    fulfillmentLineItems: {
      pageInfo: { hasNextPage: boolean };
      nodes: { quantity: number; lineItem: RawLineItem }[];
    };
  }[];
  refunds: {
    id: string;
    createdAt: string;
    refundLineItems: {
      pageInfo: { hasNextPage: boolean };
      nodes: {
        id: string;
        quantity: number;
        restockType: string;
        restocked: boolean;
        location: { id: string } | null;
        lineItem: RawLineItem;
      }[];
    };
  }[];
}

interface RawTransfer {
  id: string;
  name: string;
  status: string;
  origin: { location: { id: string } | null } | null;
  destination: { location: { id: string } | null } | null;
  shipments: {
    pageInfo: { hasNextPage: boolean };
    nodes: {
      id: string;
      status: string;
      dateCreated: string | null;
      dateShipped: string | null;
      dateReceived: string | null;
      lineItems: {
        pageInfo: { hasNextPage: boolean };
        nodes: {
          quantity: number;
          acceptedQuantity: number;
          rejectedQuantity: number;
          unreceivedQuantity: number;
          inventoryItem: { id: string; sku: string | null } | null;
        }[];
      };
    }[];
  };
}

// --- raw to snapshot ---------------------------------------------------------

function toLocation(l: RawLocation): ShopifyLocation {
  return { id: l.id, name: l.name, isActive: l.isActive };
}

function toVariant(v: RawVariant): ShopifyVariant {
  const levels = v.inventoryItem.inventoryLevels;
  if (levels.pageInfo.hasNextPage) {
    throw new ShopifyError(
      `Variant ${v.sku ?? v.id} is stocked at more than 20 locations; not supported yet`,
      'OVERFLOW',
    );
  }
  return {
    variantId: v.id,
    inventoryItemId: v.inventoryItem.id,
    sku: v.sku && v.sku.trim() ? v.sku.trim() : null,
    title: v.title,
    productTitle: v.product.title,
    productStatus: v.product.status,
    tracked: v.inventoryItem.tracked,
    levels: levels.nodes.map((n) => {
      const q = (name: string) => {
        const found = n.quantities.find((x) => x.name === name);
        if (!found) throw new ShopifyError(`Level for ${v.sku ?? v.id} has no "${name}" quantity`, 'SHAPE');
        return found.quantity;
      };
      return {
        locationId: n.location.id,
        onHand: q('on_hand'),
        available: q('available'),
        committed: q('committed'),
        damaged: q('damaged'),
        qualityControl: q('quality_control'),
        updatedAt: n.updatedAt,
      };
    }),
  };
}

function toLine(li: RawLineItem, quantity: number): ShopifyLine {
  return {
    quantity,
    inventoryItemId: li.variant?.inventoryItem?.id ?? null,
    sku: li.sku && li.sku.trim() ? li.sku.trim() : null,
    title: li.title,
  };
}

function toOrder(o: RawOrder): ShopifyOrder {
  // Order-level lists are capped at 10. An order with more fulfilments or
  // refunds than that would lose movements silently, so refuse instead.
  if (o.fulfillments.length >= 10 || o.refunds.length >= 10) {
    throw new ShopifyError(`Order ${o.name} has 10 or more fulfilments or refunds; not supported yet`, 'OVERFLOW');
  }
  const fulfillments: ShopifyFulfillment[] = o.fulfillments.map((f) => {
    if (f.fulfillmentLineItems.pageInfo.hasNextPage) {
      throw new ShopifyError(`Fulfilment on ${o.name} has more than 25 lines; not supported yet`, 'OVERFLOW');
    }
    return {
      id: f.id,
      status: f.status,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      locationId: f.location?.id ?? null,
      lines: f.fulfillmentLineItems.nodes.map((n) => toLine(n.lineItem, n.quantity)),
    };
  });
  const refunds: ShopifyRefund[] = o.refunds.map((r) => {
    if (r.refundLineItems.pageInfo.hasNextPage) {
      throw new ShopifyError(`Refund on ${o.name} has more than 25 lines; not supported yet`, 'OVERFLOW');
    }
    return {
      id: r.id,
      createdAt: r.createdAt,
      lines: r.refundLineItems.nodes.map((n) => ({
        ...toLine(n.lineItem, n.quantity),
        id: n.id,
        restockType: n.restockType,
        restocked: n.restocked,
        locationId: n.location?.id ?? null,
      })),
    };
  });
  return { id: o.id, name: o.name, createdAt: o.createdAt, fulfillments, refunds };
}

function toTransfer(t: RawTransfer): ShopifyTransfer {
  if (t.shipments.pageInfo.hasNextPage) {
    throw new ShopifyError(`Transfer ${t.name} has more than 10 shipments; not supported yet`, 'OVERFLOW');
  }
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    originLocationId: t.origin?.location?.id ?? null,
    destinationLocationId: t.destination?.location?.id ?? null,
    shipments: t.shipments.nodes.map((sh) => {
      if (sh.lineItems.pageInfo.hasNextPage) {
        throw new ShopifyError(`Shipment on ${t.name} has more than 50 lines; not supported yet`, 'OVERFLOW');
      }
      return {
        id: sh.id,
        status: sh.status,
        dateCreated: sh.dateCreated,
        dateShipped: sh.dateShipped,
        dateReceived: sh.dateReceived,
        lines: sh.lineItems.nodes.map((n) => ({
          inventoryItemId: n.inventoryItem?.id ?? null,
          sku: n.inventoryItem?.sku?.trim() || null,
          quantity: n.quantity,
          accepted: n.acceptedQuantity,
          rejected: n.rejectedQuantity,
          unreceived: n.unreceivedQuantity,
        })),
      };
    }),
  };
}
