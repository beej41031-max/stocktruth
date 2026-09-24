/**
 * Everything the adapter reads from Shopify, flattened into plain data.
 *
 * The network code (client.ts, fetch.ts) produces one of these; the mapping
 * (index.ts) consumes one. Keeping them apart means every rule about what a
 * Shopify record *means* is testable against a hand-built snapshot, with no
 * store and no token, and a real store's snapshot can be saved to disk and
 * replayed exactly.
 */

export interface ShopifySnapshot {
  /** e.g. "northfold.myshopify.com". Shown in run records. */
  shop: string;
  apiVersion: string;
  /** When the snapshot was taken. The knowledge clock for every row in it. */
  fetchedAt: string;
  /**
   * Orders were fetched if updated at or after this instant. Any count older
   * than this cannot be carried forward: the fulfilments in between were never
   * read. The adapter refuses rather than pretend otherwise.
   */
  ordersSince: string;
  locations: ShopifyLocation[];
  variants: ShopifyVariant[];
  orders: ShopifyOrder[];
  /** Absent in snapshots saved before transfers were read. */
  transfers?: ShopifyTransfer[];
}

export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ShopifyVariant {
  variantId: string;
  /** The adapter's item id. Inventory in Shopify hangs off this, not the variant. */
  inventoryItemId: string;
  sku: string | null;
  title: string;
  productTitle: string;
  /** ACTIVE, DRAFT, ARCHIVED, or whatever Shopify adds next. */
  productStatus: string;
  /** False means Shopify does not count this variant's stock at all. */
  tracked: boolean;
  levels: ShopifyInventoryLevel[];
}

export interface ShopifyInventoryLevel {
  locationId: string;
  /**
   * Units physically at the location, by Shopify's account. Includes units
   * committed to orders not yet shipped, because those are still on the shelf.
   * This, not "available", is the book.
   */
  onHand: number;
  available: number;
  committed: number;
  /**
   * Physically present but not sellable. Inside on_hand. Many 3PL reports
   * leave these out, so the adapter can compare on a sellable basis.
   * Absent in snapshots saved before they were read.
   */
  damaged?: number;
  qualityControl?: number;
  updatedAt: string;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  fulfillments: ShopifyFulfillment[];
  refunds: ShopifyRefund[];
}

export interface ShopifyFulfillment {
  id: string;
  /** SUCCESS, CANCELLED, PENDING, OPEN, ERROR, FAILURE. */
  status: string;
  createdAt: string;
  updatedAt: string;
  locationId: string | null;
  lines: ShopifyLine[];
}

export interface ShopifyRefund {
  id: string;
  createdAt: string;
  lines: ShopifyRefundLine[];
}

export interface ShopifyLine {
  quantity: number;
  /** Null for custom line items and deleted variants: nothing to attach to. */
  inventoryItemId: string | null;
  sku: string | null;
  title: string;
}

export interface ShopifyRefundLine extends ShopifyLine {
  id: string;
  /** RETURN, CANCEL, NO_RESTOCK, LEGACY_RESTOCK. */
  restockType: string;
  restocked: boolean;
  locationId: string | null;
}

export interface ShopifyTransfer {
  id: string;
  name: string;
  status: string;
  /** Null when stock arrives from outside Shopify's locations. */
  originLocationId: string | null;
  destinationLocationId: string | null;
  shipments: ShopifyShipment[];
}

export interface ShopifyShipment {
  id: string;
  /** DRAFT, IN_TRANSIT, PARTIALLY_RECEIVED, RECEIVED, OTHER. */
  status: string;
  dateCreated: string | null;
  /** Origin on-hand falls at this moment. */
  dateShipped: string | null;
  /**
   * The FIRST receipt only. A shipment received in two batches shows one
   * date, so a later batch cannot be placed in time. Safe: at worst this
   * produces a refused gap, never a false agreement.
   */
  dateReceived: string | null;
  lines: ShopifyShipmentLine[];
}

export interface ShopifyShipmentLine {
  inventoryItemId: string | null;
  sku: string | null;
  quantity: number;
  accepted: number;
  rejected: number;
  unreceived: number;
}
