import type {
  CountLine,
  EvidenceSource,
  ItemRef,
  Movement,
  MovementType,
  ReconciliationPolicy,
  ScopeEvidence,
  ScopeRef,
  SiteRef,
  SourceHealth,
} from '@stocktruth/engine';
import type { ShopifyLine, ShopifySnapshot, ShopifyVariant } from './snapshot';
import type { ThreePlLine, ThreePlReport } from './threepl';

export * from './snapshot';
export * from './threepl';
export { ShopifyAdminClient, ShopifyError, REQUIRED_SCOPES, DEFAULT_API_VERSION, assertReadOnly } from './client';
export { fetchShopifySnapshot, type FetchOptions } from './fetch';

export interface ShopifyAdapterOptions {
  /** The 3PL's warehouse codes, mapped to Shopify location ids. */
  locationMap?: Record<string, string>;
  /** Where report lines with no warehouse column go. Required if any are blank. */
  defaultLocationId?: string;
  /**
   * What the 3PL's quantity includes. "on_hand" (default): everything
   * physically there. "sellable": excludes damaged and quality-control stock,
   * which Shopify counts in on_hand but many 3PL reports leave out. Getting
   * this wrong invents a gap every time a unit is marked damaged.
   */
  threePlBasis?: 'on_hand' | 'sellable';
  /** How often the Shopify snapshot is expected to be refreshed. */
  shopifySyncMinutes?: number;
  /** How often the 3PL is expected to send a report. */
  threePlSyncMinutes?: number;
  policy?: Partial<ReconciliationPolicy>;
}

/** Things the engine has no concept for, but a person reading the audit should see. */
export interface ShopifyDiagnostics {
  /** SKUs the 3PL holds that Shopify has no variant for. */
  unknownThreePlSkus: { sku: string; quantity: number; row: number }[];
  /** Refund lines restocked as CANCEL: never shipped, so no physical movement. */
  cancelRestocksSkipped: number;
  /** Refund lines not restocked at all. */
  noRestockLines: number;
  /** Order lines with no inventory item behind them (custom items, deleted variants). */
  unlinkedLines: { order: string; sku: string | null; title: string; quantity: number }[];
  /** Fulfilments in a state that may or may not have moved stock. */
  ambiguousFulfilments: { order: string; status: string }[];
  /** Variants Shopify does not track inventory for. */
  untrackedVariants: string[];
  /** Untracked variants the 3PL physically holds: Shopify will sell these without limit. */
  untrackedHeldByThreePl: { sku: string; quantity: number }[];
  /** SKUs shared by more than one variant. */
  duplicateSkus: string[];
  /** Transfer units rejected on receipt: left the origin, stocked nowhere. */
  rejectedTransferUnits: { transfer: string; sku: string | null; quantity: number }[];
  /** On an on_hand basis, compared stock Shopify holds as damaged or in QC. */
  unavailableInBook: { sku: string; quantity: number }[];
  /** False for snapshots saved before transfers were read. */
  transfersRead: boolean;
}

const SHOPIFY_SOURCE = 'shopify';
const THREEPL_SOURCE = '3pl-report';
const UNIT = 'each';

/**
 * Shopify as an evidence source, read-only.
 *
 *   book       Shopify's on_hand at each location. Not "available": units
 *              committed to unshipped orders are still on the shelf.
 *   count      the 3PL's stock report, matched to variants by SKU.
 *   movements  successful fulfilments out; refunds restocked as RETURN back in.
 *
 * Shopify's Admin API cannot read the history of manual adjustments, so
 * receipts entered by hand, cycle-count corrections and changes made by other
 * apps are invisible. The adapter says so on every scope
 * (movementFeedComplete: false), and the engine then refuses to say which
 * side of a gap is wrong. See decision 0025.
 *
 * Snapshot-only, like the CSV adapter: it cannot say what was known last
 * Tuesday, so supportsKnownAt is false.
 */
export class ShopifyEvidenceSource implements EvidenceSource {
  readonly supportsKnownAt = false;
  readonly adapterName: string;

  private readonly scopes: ScopeEvidence[] = [];
  private readonly policy: Partial<ReconciliationPolicy>;
  private readonly diag: ShopifyDiagnostics = {
    unknownThreePlSkus: [],
    cancelRestocksSkipped: 0,
    noRestockLines: 0,
    unlinkedLines: [],
    ambiguousFulfilments: [],
    untrackedVariants: [],
    untrackedHeldByThreePl: [],
    duplicateSkus: [],
    rejectedTransferUnits: [],
    unavailableInBook: [],
    transfersRead: true,
  };

  constructor(snapshot: ShopifySnapshot, report: ThreePlReport, options: ShopifyAdapterOptions = {}) {
    this.adapterName = `shopify:${snapshot.shop}`;
    this.policy = options.policy ?? {};

    const fetchedAt = date(snapshot.fetchedAt, 'snapshot fetchedAt');
    const ordersSince = date(snapshot.ordersSince, 'snapshot ordersSince');

    // --- items ---------------------------------------------------------------
    const skuOwners = new Map<string, ShopifyVariant[]>();
    for (const v of snapshot.variants) {
      if (!v.sku) continue;
      const key = normaliseSku(v.sku);
      skuOwners.set(key, [...(skuOwners.get(key) ?? []), v]);
    }
    // Shopify allows two variants to share a SKU. A 3PL report keyed by SKU
    // cannot tell them apart, so neither gets a number.
    const ambiguous = new Set<string>();
    for (const [key, owners] of skuOwners) {
      if (owners.length > 1) {
        this.diag.duplicateSkus.push(key);
        for (const v of owners) ambiguous.add(v.inventoryItemId);
      }
    }

    const items = new Map<string, ItemRef>();
    for (const v of snapshot.variants) {
      if (items.has(v.inventoryItemId)) throw new Error(`Inventory item ${v.inventoryItemId} appears twice`);
      if (!v.tracked) this.diag.untrackedVariants.push(v.sku ?? v.variantId);
      items.set(v.inventoryItemId, {
        id: v.inventoryItemId,
        sku: v.sku,
        name: v.title && v.title !== 'Default Title' ? `${v.productTitle} / ${v.title}` : v.productTitle,
        stockUnit: UNIT,
        active: v.productStatus === 'ACTIVE',
        blocked: !v.tracked,
        blockedReason: v.tracked
          ? null
          : 'Shopify does not track inventory for this variant, so its figure is not a claim about stock',
        identityAmbiguous: ambiguous.has(v.inventoryItemId) || undefined,
      });
    }

    // --- counts from the 3PL report --------------------------------------------
    const counts = new Map<string, CountLine>();
    const reportTimes: number[] = [];
    for (const line of report.lines) {
      const locationId = this.locationFor(line, options);
      if (line.asOf.getTime() < ordersSince.getTime()) {
        // Carrying this count forward needs every fulfilment since it was
        // taken, and those were never read. Refuse loudly: a quiet version of
        // this mistake looks exactly like stock loss.
        throw new Error(
          `3PL report row ${line.row} is dated ${line.asOf.toISOString()}, before orders were read ` +
            `(${ordersSince.toISOString()}). Fetch orders from before the report.`,
        );
      }
      reportTimes.push(line.asOf.getTime());
      const owners = skuOwners.get(normaliseSku(line.sku));
      if (!owners) {
        this.diag.unknownThreePlSkus.push({ sku: line.sku, quantity: line.quantity, row: line.row });
        continue;
      }
      for (const v of owners) {
        if (!v.tracked) {
          // No book exists to compare against: Shopify is not counting it at
          // all. That is a finding about the store, not a stock position.
          this.diag.untrackedHeldByThreePl.push({ sku: line.sku, quantity: line.quantity });
          continue;
        }
        const key = scopeKey(v.inventoryItemId, locationId);
        if (counts.has(key)) {
          throw new Error(`3PL report has two lines for ${line.sku} at ${locationId} (row ${line.row})`);
        }
        counts.set(key, {
          id: `${report.reportId}#${line.row}`,
          quantity: line.quantity,
          unit: UNIT,
          countedAt: line.asOf,
          receivedAt: fetchedAt,
          countedBy: report.provider,
          sessionId: report.reportId,
          sessionWatermark: null,
        });
      }
    }

    // --- books from inventory levels -------------------------------------------
    const basis = options.threePlBasis ?? 'on_hand';
    const books = new Map<string, ScopeEvidence['book']>();
    for (const v of snapshot.variants) {
      if (!v.tracked) continue;
      for (const level of v.levels) {
        const unavailable = (level.damaged ?? 0) + (level.qualityControl ?? 0);
        if (basis === 'sellable' && (level.damaged === undefined || level.qualityControl === undefined)) {
          throw new Error(
            'This snapshot predates damaged and quality-control quantities, so a sellable basis cannot be ' +
              'computed. Take a fresh snapshot.',
          );
        }
        const key = scopeKey(v.inventoryItemId, level.locationId);
        if (basis === 'on_hand' && unavailable > 0 && counts.has(key)) {
          this.diag.unavailableInBook.push({ sku: v.sku ?? v.variantId, quantity: unavailable });
        }
        books.set(key, {
          id: `${v.inventoryItemId}@${level.locationId}:${basis}`,
          quantity: basis === 'sellable' ? level.onHand - unavailable : level.onHand,
          unit: UNIT,
          asOf: date(level.updatedAt, `level ${v.sku ?? v.variantId}`),
          sourceSystemId: SHOPIFY_SOURCE,
        });
      }
    }

    // --- movements from orders ---------------------------------------------------
    const movements = new Map<string, Movement[]>();
    const unlinkedByLocation = new Map<string, ShopifyLine[]>();
    const add = (inventoryItemId: string, locationId: string, m: Movement) => {
      const key = scopeKey(inventoryItemId, locationId);
      movements.set(key, [...(movements.get(key) ?? []), m]);
    };
    const unlinked = (order: string, locationId: string | null, line: ShopifyLine) => {
      this.diag.unlinkedLines.push({ order, sku: line.sku, title: line.title, quantity: line.quantity });
      const key = locationId ?? '(none)';
      unlinkedByLocation.set(key, [...(unlinkedByLocation.get(key) ?? []), line]);
    };
    const movement = (
      id: string,
      type: MovementType,
      quantity: number,
      at: string,
      reversalOfId?: string,
    ): Movement => ({
      id,
      type,
      quantity,
      unit: UNIT,
      occurredAt: date(at, id),
      // Shopify writes these at the moment they happen; there is no separate
      // paperwork clock to disagree with.
      recordedAt: date(at, id),
      importedAt: fetchedAt,
      sourceSystemId: SHOPIFY_SOURCE,
      reversalOfId: reversalOfId ?? null,
    });

    for (const order of snapshot.orders) {
      for (const f of order.fulfillments) {
        const known = f.status === 'SUCCESS' || f.status === 'CANCELLED';
        if (!known) this.diag.ambiguousFulfilments.push({ order: order.name, status: f.status });

        f.lines.forEach((line, i) => {
          if (!line.inventoryItemId || !f.locationId || !items.has(line.inventoryItemId)) {
            unlinked(order.name, f.locationId, line);
            return;
          }
          const id = `${f.id}#${i}`;
          if (f.status === 'SUCCESS') {
            add(line.inventoryItemId, f.locationId, movement(id, 'ISSUE', line.quantity, f.createdAt));
          } else if (f.status === 'CANCELLED') {
            // Shipped, then cancelled: stock left and came back. A reversal
            // pair, so the engine nets it to nothing but keeps both rows.
            add(line.inventoryItemId, f.locationId, movement(id, 'ISSUE', line.quantity, f.createdAt));
            add(
              line.inventoryItemId,
              f.locationId,
              movement(`${id}:cancel`, 'RETURN', line.quantity, f.updatedAt, id),
            );
          } else {
            // PENDING, OPEN, ERROR, FAILURE: stock may or may not have left.
            // A direction nobody can state is an ADJUST, which blocks.
            add(line.inventoryItemId, f.locationId, movement(id, 'ADJUST', line.quantity, f.createdAt));
          }
        });
      }

      for (const refund of order.refunds) {
        for (const line of refund.lines) {
          switch (line.restockType) {
            case 'NO_RESTOCK':
              this.diag.noRestockLines++;
              continue;
            case 'CANCEL':
              // Restocking something that never shipped moves units from
              // committed back to available. On-hand does not change, and
              // counting it would invent stock.
              this.diag.cancelRestocksSkipped++;
              continue;
          }
          if (!line.restocked) continue;
          if (!line.inventoryItemId || !line.locationId || !items.has(line.inventoryItemId)) {
            unlinked(order.name, line.locationId, line);
            continue;
          }
          // RETURN is goods coming back. LEGACY_RESTOCK predates Shopify
          // saying which kind of restock it was, so its direction is unknown.
          const type: MovementType = line.restockType === 'RETURN' ? 'RETURN' : 'ADJUST';
          add(line.inventoryItemId, line.locationId, movement(line.id, type, line.quantity, refund.createdAt));
        }
      }
    }

    // --- movements from transfers -----------------------------------------------
    if (!snapshot.transfers) this.diag.transfersRead = false;
    for (const t of snapshot.transfers ?? []) {
      for (const sh of t.shipments) {
        // A draft or ready-to-ship shipment is a hold: committed at the
        // origin, on-hand unchanged. Nothing has physically moved.
        if (sh.status === 'DRAFT' || (!sh.dateShipped && !sh.dateReceived)) continue;

        sh.lines.forEach((line, i) => {
          const asLine: ShopifyLine = { quantity: line.quantity, inventoryItemId: line.inventoryItemId, sku: line.sku, title: t.name };
          if (!line.inventoryItemId || !items.has(line.inventoryItemId)) {
            unlinked(t.name, t.originLocationId ?? t.destinationLocationId, asLine);
            return;
          }
          const id = `${sh.id}#${i}`;
          if (t.originLocationId) {
            if (sh.dateShipped) {
              // Origin on-hand falls when the shipment leaves, received or not.
              add(line.inventoryItemId, t.originLocationId, movement(`${id}:out`, 'TRANSFER_OUT', line.quantity, sh.dateShipped));
            } else {
              // Received but with no ship date: when it left the origin is
              // unknown, so its direction in time is too.
              add(
                line.inventoryItemId,
                t.originLocationId,
                movement(`${id}:out`, 'ADJUST', line.quantity, sh.dateReceived ?? sh.dateCreated ?? snapshot.fetchedAt),
              );
            }
          }
          if (t.destinationLocationId && line.accepted > 0 && sh.dateReceived) {
            // Only accepted units arrive. With no origin it is a receipt
            // from outside, not a transfer.
            add(
              line.inventoryItemId,
              t.destinationLocationId,
              movement(`${id}:in`, t.originLocationId ? 'TRANSFER_IN' : 'RECEIVE', line.accepted, sh.dateReceived),
            );
          }
          if (line.rejected > 0) {
            this.diag.rejectedTransferUnits.push({ transfer: t.name, sku: line.sku, quantity: line.rejected });
          }
        });
      }
    }

    // --- sources -------------------------------------------------------------
    const sources: SourceHealth[] = [
      {
        sourceSystemId: SHOPIFY_SOURCE,
        name: `Shopify (${snapshot.shop})`,
        expectedSyncMinutes: options.shopifySyncMinutes ?? 60,
        lastSuccessAt: fetchedAt,
      },
      {
        sourceSystemId: THREEPL_SOURCE,
        name: `${report.provider} stock report`,
        expectedSyncMinutes: options.threePlSyncMinutes ?? 1440,
        lastSuccessAt: reportTimes.length ? new Date(Math.max(...reportTimes)) : null,
      },
    ];

    // --- scopes: every item/location with a book or a count -------------------
    const keys = new Set<string>([...books.keys(), ...counts.keys()]);
    const siteUnlinked = [...unlinkedByLocation.values()].reduce((n, lines) => n + lines.length, 0);
    for (const key of [...keys].sort()) {
      const [itemId, locationId] = splitKey(key);
      const item = items.get(itemId)!;
      const here = [...(unlinkedByLocation.get(locationId) ?? []), ...(unlinkedByLocation.get('(none)') ?? [])];
      const possiblyRelated = item.sku
        ? here.filter((l) => l.sku && normaliseSku(l.sku) === normaliseSku(item.sku!)).length
        : 0;
      this.scopes.push({
        item,
        locationId,
        book: books.get(key) ?? null,
        count: counts.get(key) ?? null,
        movements: movements.get(key) ?? [],
        unlinkedMovementCount: siteUnlinked,
        possiblyRelatedUnlinkedCount: possiblyRelated,
        sources,
        movementFeedComplete: false,
      });
    }
  }

  diagnostics(): ShopifyDiagnostics {
    return structuredClone(this.diag);
  }

  async listScopes(_site: SiteRef): Promise<ScopeRef[]> {
    return this.scopes.map((s) => ({ itemId: s.item.id, locationId: s.locationId }));
  }

  async loadScope(_site: SiteRef, scope: ScopeRef): Promise<ScopeEvidence | null> {
    return this.scopes.find((s) => s.item.id === scope.itemId && s.locationId === scope.locationId) ?? null;
  }

  async loadSite(_site: SiteRef): Promise<ScopeEvidence[]> {
    return [...this.scopes];
  }

  async loadPolicy(_site: SiteRef): Promise<Partial<ReconciliationPolicy>> {
    return { ...this.policy };
  }

  private locationFor(line: ThreePlLine, options: ShopifyAdapterOptions): string {
    if (line.warehouse) {
      const mapped = options.locationMap?.[line.warehouse];
      if (!mapped) {
        throw new Error(
          `3PL report row ${line.row}: warehouse "${line.warehouse}" is not mapped to a Shopify location`,
        );
      }
      return mapped;
    }
    if (!options.defaultLocationId) {
      throw new Error(`3PL report row ${line.row} has no warehouse and no default location was given`);
    }
    return options.defaultLocationId;
  }
}

export function normaliseSku(sku: string): string {
  return sku.trim().toUpperCase().replace(/\s+/g, '');
}

function scopeKey(itemId: string, locationId: string): string {
  return `${itemId}|${locationId}`;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

function date(value: string, label: string): Date {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw new Error(`${label}: "${value}" is not a date`);
  return d;
}
