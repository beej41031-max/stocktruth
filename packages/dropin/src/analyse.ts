import {
  DEFAULT_POLICY,
  explain,
  reconcile,
  type ReconciliationInput,
  type ReconciliationState,
  type ScopeEvidence,
} from '@stocktruth/engine';
import {
  ShopifyEvidenceSource,
  normaliseSku,
  type ShopifyDiagnostics,
  type ShopifySnapshot,
  type ThreePlReport,
} from './shopify';
import type { Unit } from './costs';
import { when } from './format';

export type Answer =
  | { kind: 'no-changes'; locationId: string; note: string; at: string }
  | { kind: 'change'; scopeId: string; direction: 'in' | 'out'; units: number; only: boolean; note: string; at: string }
  | { kind: 'adjustment'; scopeId: string; movementId: string; as: 'in' | 'out' | 'none'; note: string; at: string };

export interface AnalyseInput {
  snapshot: ShopifySnapshot;
  report: ThreePlReport;
  provider: string;
  locationMap: Record<string, string>;
  defaultLocationId?: string;
  basis: 'on_hand' | 'sellable';
  costs: Map<string, Unit>;
  answers: Answer[];
}

export type Kind = 'agrees' | 'overstated' | 'understated' | 'unsized' | 'uncounted' | 'unbooked';

export interface Step {
  id: string;
  label: string;
  type: string;
  quantity: number;
  signed: number;
  at: Date;
  insideBook: boolean;
}

export interface Adjustment {
  id: string;
  label: string;
  why: string;
  quantity: number;
  at: Date | null;
}

export interface Row {
  id: string;
  sku: string;
  name: string;
  locationId: string;
  location: string;
  kind: Kind;
  held: boolean;
  state: ReconciliationState;
  book: number | null;
  count: number | null;
  gap: number | null;
  // shopify minus evidence: positive means shopify holds more
  diff: number | null;
  evidence: number | null;
  position: number | null;
  countAt: Date | null;
  bookAt: Date | null;
  steps: Step[];
  // changes the user reported with no time of their own: signed units
  unplaced: { id: string; units: number; note: string }[];
  adjustments: Adjustment[];
  blockers: { code: string; short: string; resolution: string }[];
  caveats: string[];
  ifCleared: { quantity: number | null; assuming: string[] } | null;
  unitValue: number | null;
  value: number | null;
  onYourWord: boolean;
}

export interface Question {
  id: string;
  code: string;
  mode: 'location' | 'adjustment' | 'fix';
  locationId: string | null;
  headline: string;
  detail: string;
  rows: string[];
  units: number;
  value: number | null;
  unvalued: number;
  unsized: number;
}

export interface Finding {
  id: string;
  text: string;
  units: number | null;
  value: number | null;
}

export interface Bucket {
  rows: number;
  units: number;
  value: number | null;
  unvalued: number;
}

export interface Analysis {
  shop: string;
  provider: string;
  shopifyAt: Date;
  reportFrom: Date;
  reportTo: Date;
  basis: 'on_hand' | 'sellable';
  valueBasis: 'cost' | 'price' | null;
  rows: Row[];
  questions: Question[];
  outside: Finding[];
  notes: string[];
  counts: Record<Kind, number>;
  overstated: Bucket;
  understated: Bucket;
  outsideValue: number | null;
  answered: number;
  diagnostics: ShopifyDiagnostics;
}

const IDENTITY = { siteId: 'dropin' };

function labels(snapshot: ShopifySnapshot): (id: string) => string {
  const known = new Map<string, string>();
  for (const o of snapshot.orders) {
    for (const f of o.fulfillments) known.set(f.id, `Order ${o.name}`);
    for (const r of o.refunds) for (const l of r.lines) known.set(l.id, `Refund on order ${o.name}`);
  }
  for (const t of snapshot.transfers ?? []) for (const s of t.shipments) known.set(s.id, `Transfer ${t.name}`);
  return (id) => {
    const direct = known.get(id);
    if (direct) return direct;
    const stem = id.replace(/:(cancel|in|out)$/, '').split('#')[0]!;
    const hit = known.get(stem) ?? known.get(id.split('#')[0]!);
    if (!hit) return id.split('/').pop() ?? id;
    return id.endsWith(':cancel') ? `${hit} (cancelled)` : hit;
  };
}

// the engine's wording is written for any host; trim what reads oddly in a browser
function plainer(text: string): string {
  return text
    .replace(/(\d)\s+each\b/g, (_m, d: string) => `${d} units`)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => when(new Date(iso)));
}

function adjustmentWhy(id: string): string {
  if (id.includes('RefundLineItem')) return 'A refund restocked this the old way, which does not say whether goods came back to the shelf.';
  if (id.includes('Fulfillment')) return 'A fulfilment that was never confirmed, so the stock may or may not have left.';
  if (id.includes('InventoryShipment')) return 'A transfer received with no ship date, so when it left the origin is unknown.';
  return 'A change the feed recorded without saying which way it went.';
}

function unitValue(sku: string | null, costs: Map<string, Unit>, basis: 'cost' | 'price' | null): number | null {
  if (!sku || !basis) return null;
  const u = costs.get(normaliseSku(sku));
  return (basis === 'cost' ? u?.cost : u?.price) ?? null;
}

interface Applied {
  scope: ScopeEvidence;
  touched: boolean;
  interval: { id: string; quantity: number }[];
  unplaced: Row['unplaced'];
}

function applyAnswers(scope: ScopeEvidence, answers: Answer[]): Applied {
  const id = `${scope.item.id}|${scope.locationId}`;
  let out: ScopeEvidence = { ...scope, movements: scope.movements.map((m) => ({ ...m })) };
  let touched = false;
  const interval: Applied['interval'] = [];
  const unplaced: Applied['unplaced'] = [];

  for (const a of answers) {
    if (a.kind === 'no-changes' && a.locationId === scope.locationId) {
      out = { ...out, movementFeedComplete: true };
      touched = true;
    }
    if (a.kind === 'change' && a.scopeId === id) {
      // told what changed, not when. it goes to the engine as a change inside
      // the interval, never as a row with a time somebody made up
      const quantity = a.direction === 'in' ? a.units : -a.units;
      interval.push({ id: `answer:${a.at}`, quantity });
      unplaced.push({ id: `answer:${a.at}`, units: quantity, note: a.note });
      out = { ...out, movementFeedComplete: a.only ? true : out.movementFeedComplete };
      touched = true;
    }
    if (a.kind === 'adjustment' && a.scopeId === id) {
      const movements =
        a.as === 'none'
          ? out.movements.filter((m) => m.id !== a.movementId)
          : out.movements.map((m) => (m.id === a.movementId ? { ...m, type: a.as === 'in' ? ('RECEIVE' as const) : ('ISSUE' as const) } : m));
      out = { ...out, movements };
      touched = true;
    }
  }
  return { scope: out, touched, interval, unplaced };
}

export async function analyse(input: AnalyseInput): Promise<Analysis> {
  const { snapshot, report, answers } = input;
  const source = new ShopifyEvidenceSource(snapshot, report, {
    locationMap: input.locationMap,
    defaultLocationId: input.defaultLocationId,
    threePlBasis: input.basis,
  });
  const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy(IDENTITY)) };
  const evaluatedAt = new Date(snapshot.fetchedAt);
  const locationName = new Map(snapshot.locations.map((l) => [l.id, l.name]));
  const labelFor = labels(snapshot);

  const anyCost = [...input.costs.values()].some((u) => u.cost != null);
  const anyPrice = [...input.costs.values()].some((u) => u.price != null);
  const valueBasis: 'cost' | 'price' | null = anyCost ? 'cost' : anyPrice ? 'price' : null;

  const rows: Row[] = [];
  for (const raw of await source.loadSite(IDENTITY)) {
    const { scope, touched, interval, unplaced } = applyAnswers(raw, answers);
    const ri: ReconciliationInput = {
      item: scope.item,
      locationId: scope.locationId,
      book: scope.book,
      count: scope.count,
      movements: scope.movements,
      unlinkedMovementCount: scope.unlinkedMovementCount,
      possiblyRelatedUnlinkedCount: scope.possiblyRelatedUnlinkedCount,
      sources: scope.sources,
      policy,
      evaluatedAt,
      movementFeedComplete: scope.movementFeedComplete,
      intervalAdjustments: interval.length ? interval : undefined,
    };
    const r = reconcile(ri);
    const e = explain(ri);

    const gap = r.varianceAtCount;
    const sku = scope.item.sku ?? scope.item.id;
    const onlyGap = e.blockers.length > 0 && e.blockers.every((b) => b.code === 'BOOK_GAP_UNATTRIBUTABLE');

    let kind: Kind;
    if (!scope.count) kind = 'uncounted';
    else if (!scope.book) kind = 'unbooked';
    else if (e.refused && !(onlyGap && gap != null)) kind = 'unsized';
    else if (gap == null) kind = 'unsized';
    else if (gap === 0) kind = 'agrees';
    else kind = gap < 0 ? 'overstated' : 'understated';

    const per = unitValue(sku, input.costs, valueBasis);
    const value = per != null && gap != null && (kind === 'overstated' || kind === 'understated') ? Math.abs(gap) * per : null;

    const from = scope.count?.countedAt.getTime() ?? 0;
    const bookAt = scope.book?.asOf ?? null;
    const steps: Step[] = scope.count
      ? scope.movements
          .filter((m) => m.occurredAt && m.occurredAt.getTime() > from && m.type !== 'ADJUST')
          .map((m) => {
            const sign = m.type === 'RECEIVE' || m.type === 'RETURN' || m.type === 'TRANSFER_IN' ? 1 : -1;
            const at = m.occurredAt!;
            return {
              id: m.id,
              label: labelFor(m.id),
              type: m.type,
              quantity: m.quantity,
              signed: sign * m.quantity,
              at,
              insideBook: bookAt ? at.getTime() <= bookAt.getTime() : false,
            };
          })
          .sort((a, b) => a.at.getTime() - b.at.getTime())
      : [];

    const adjustments: Adjustment[] = scope.count
      ? scope.movements
          .filter((m) => m.type === 'ADJUST' && m.occurredAt && m.occurredAt.getTime() > from)
          .map((m) => ({ id: m.id, label: labelFor(m.id), why: adjustmentWhy(m.id), quantity: m.quantity, at: m.occurredAt }))
      : [];

    rows.push({
      id: `${scope.item.id}|${scope.locationId}`,
      sku,
      name: scope.item.name,
      locationId: scope.locationId ?? '',
      location: locationName.get(scope.locationId ?? '') ?? scope.locationId ?? '',
      kind,
      held: e.refused,
      state: r.state,
      book: r.bookQuantity,
      count: r.physicalQuantity,
      gap,
      diff: gap == null ? null : gap === 0 ? 0 : -gap,
      evidence: r.bookQuantity != null && gap != null ? r.bookQuantity + gap : null,
      position: r.derivedQuantity,
      countAt: scope.count?.countedAt ?? null,
      bookAt,
      steps,
      unplaced,
      adjustments,
      blockers: e.blockers.map((b) => ({ code: b.code, short: b.short, resolution: plainer(b.resolution) })),
      caveats: e.caveats.map((c) => c.short),
      ifCleared: e.ifCleared,
      unitValue: per,
      value,
      onYourWord: touched,
    });
  }

  const counts: Record<Kind, number> = { agrees: 0, overstated: 0, understated: 0, unsized: 0, uncounted: 0, unbooked: 0 };
  for (const r of rows) counts[r.kind]++;

  const bucket = (kind: Kind): Bucket => {
    const mine = rows.filter((r) => r.kind === kind);
    const priced = mine.filter((r) => r.value != null);
    return {
      rows: mine.length,
      units: mine.reduce((n, r) => n + Math.abs(r.gap ?? 0), 0),
      value: valueBasis && priced.length ? priced.reduce((n, r) => n + r.value!, 0) : null,
      unvalued: mine.length - priced.length,
    };
  };

  const diagnostics = source.diagnostics();
  const outside = findings(diagnostics, input, valueBasis);
  const outsideValue = valueBasis ? outside.reduce((n, f) => n + (f.value ?? 0), 0) : null;

  const times = report.lines.map((l) => l.asOf.getTime());
  const notes: string[] = [];
  if (diagnostics.duplicateSkus.length) notes.push(`${diagnostics.duplicateSkus.length} SKU(s) are used by more than one Shopify variant, so no figure is given for them.`);

  return {
    shop: snapshot.shop,
    provider: input.provider,
    shopifyAt: evaluatedAt,
    reportFrom: new Date(Math.min(...times)),
    reportTo: new Date(Math.max(...times)),
    basis: input.basis,
    valueBasis,
    rows,
    questions: questions(rows, input, valueBasis),
    outside,
    notes,
    counts,
    overstated: bucket('overstated'),
    understated: bucket('understated'),
    outsideValue,
    answered: answers.length,
    diagnostics,
  };
}

function questions(rows: Row[], input: AnalyseInput, basis: 'cost' | 'price' | null): Question[] {
  const out: Question[] = [];
  const held = rows.filter((r) => r.held && r.kind !== 'uncounted' && r.kind !== 'unbooked');
  const sumValue = (rs: Row[]) => (basis && rs.some((r) => r.value != null) ? rs.reduce((n, r) => n + (r.value ?? 0), 0) : null);
  const sized = (rs: Row[]) => rs.filter((r) => r.gap != null);

  const gapRows = held.filter((r) => r.blockers.some((b) => b.code === 'BOOK_GAP_UNATTRIBUTABLE'));
  const byLocation = new Map<string, Row[]>();
  for (const r of gapRows) byLocation.set(r.locationId, [...(byLocation.get(r.locationId) ?? []), r]);
  for (const [locationId, rs] of byLocation) {
    const place = rs[0]!.location;
    const at = rs.reduce<Date | null>((d, r) => (r.countAt && (!d || r.countAt < d) ? r.countAt : d), null);
    out.push({
      id: `gap:${locationId}`,
      code: 'BOOK_GAP_UNATTRIBUTABLE',
      mode: 'location',
      locationId,
      headline: `Has anyone changed stock at ${place} by hand since the report${at ? ` (${at.toISOString().slice(11, 16)} UTC)` : ''}?`,
      detail:
        `Shopify's API cannot see manual adjustments, receipts typed in by hand, or changes made by other apps. ` +
        `Check each variant's inventory history in Shopify, and ask ${input.provider} whether they processed anything after their report that is not in it. ` +
        `If nothing was changed, the gaps stand.`,
      rows: rs.map((r) => r.id),
      units: sized(rs).reduce((n, r) => n + Math.abs(r.gap!), 0),
      value: sumValue(rs),
      unvalued: rs.filter((r) => r.value == null).length,
      unsized: 0,
    });
  }

  const adj = held.filter((r) => r.blockers.some((b) => b.code === 'ADJUSTMENT_IN_INTERVAL'));
  if (adj.length) {
    out.push({
      id: 'adjustment',
      code: 'ADJUSTMENT_IN_INTERVAL',
      mode: 'adjustment',
      locationId: null,
      headline: `What did ${adj.length === 1 ? 'one manual adjustment' : `${adj.length} manual adjustments`} record, stock in or stock out?`,
      detail: 'An adjustment with no direction cannot be applied either way. Find what it recorded and the position follows.',
      rows: adj.map((r) => r.id),
      units: 0,
      value: null,
      unvalued: adj.length,
      unsized: adj.length,
    });
  }

  const others = new Map<string, Row[]>();
  for (const r of held) {
    for (const b of r.blockers) {
      if (b.code === 'BOOK_GAP_UNATTRIBUTABLE' || b.code === 'ADJUSTMENT_IN_INTERVAL') continue;
      others.set(b.code, [...(others.get(b.code) ?? []), r]);
    }
  }
  for (const [code, rs] of others) {
    const first = rs[0]!.blockers.find((b) => b.code === code)!;
    out.push({
      id: `fix:${code}`,
      code,
      mode: 'fix',
      locationId: null,
      headline: first.short,
      detail: first.resolution,
      rows: rs.map((r) => r.id),
      units: 0,
      value: null,
      unvalued: rs.length,
      unsized: rs.length,
    });
  }

  return out.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.rows.length - a.rows.length);
}

function findings(d: ShopifyDiagnostics, input: AnalyseInput, basis: 'cost' | 'price' | null): Finding[] {
  const out: Finding[] = [];
  const priced = (sku: string | null, n: number) => {
    const per = unitValue(sku, input.costs, basis);
    return per == null ? null : per * n;
  };
  const who = input.provider;
  for (const u of d.unknownThreePlSkus) {
    out.push({
      id: `unknown:${u.sku}`,
      text: `${who} holds ${u.quantity.toLocaleString('en-GB')} x ${u.sku}, which Shopify has no variant for (report row ${u.row}). It cannot be sold from the store.`,
      units: u.quantity,
      value: priced(u.sku, u.quantity),
    });
  }
  for (const u of d.untrackedHeldByThreePl) {
    out.push({
      id: `untracked:${u.sku}`,
      text: `${who} holds ${u.quantity.toLocaleString('en-GB')} x ${u.sku}, but Shopify does not track its stock, so it can be sold without limit.`,
      units: u.quantity,
      value: priced(u.sku, u.quantity),
    });
  }
  for (const r of d.rejectedTransferUnits) {
    out.push({
      id: `rejected:${r.transfer}:${r.sku}`,
      text: `Transfer ${r.transfer}: ${r.quantity.toLocaleString('en-GB')} x ${r.sku ?? 'an unknown item'} rejected on receipt. It left the origin and is stocked nowhere.`,
      units: r.quantity,
      value: priced(r.sku, r.quantity),
    });
  }
  for (const u of d.unlinkedLines) {
    out.push({
      id: `unlinked:${u.order}:${u.title}`,
      text: `Order ${u.order} shipped ${u.quantity.toLocaleString('en-GB')} x "${u.title}"${u.sku ? ` (sku "${u.sku}")` : ''} with no product behind it, so no stock record moved.`,
      units: u.quantity,
      value: priced(u.sku, u.quantity),
    });
  }
  for (const u of d.unavailableInBook) {
    out.push({
      id: `damaged:${u.sku}`,
      text: `${u.sku}: ${u.quantity.toLocaleString('en-GB')} damaged or in quality control inside Shopify's on-hand. If the 3PL report leaves these out, compare on sellable stock.`,
      units: u.quantity,
      value: null,
    });
  }
  if (d.cancelRestocksSkipped) out.push({ id: 'cancel', text: `${d.cancelRestocksSkipped} refund line(s) were restocked as cancellations. They never shipped, so they are not counted as stock coming back.`, units: null, value: null });
  if (d.noRestockLines) out.push({ id: 'norestock', text: `${d.noRestockLines} refund line(s) were not restocked.`, units: null, value: null });
  if (!d.transfersRead) out.push({ id: 'transfers', text: 'This snapshot was taken before transfers were read, so transfers will show as unexplained gaps.', units: null, value: null });
  return out;
}
