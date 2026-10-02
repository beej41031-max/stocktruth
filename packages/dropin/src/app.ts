import { ENGINE_VERSION } from '@stocktruth/engine';
import demoSnapshot from '../demo/snapshot.json';
import demoReport from '../demo/3pl-report.csv';
import demoCosts from '../demo/costs.csv';
import { analyse, type Analysis, type Answer, type Kind, type Row, type Question } from './analyse';
import { readCosts, type Unit } from './costs';
import { readTable, type Table } from './csv';
import { esc, money, plural, signed, units, when, clock } from './format';
import { packHtml, packMessage, csv as csvOut } from './pack';
import { buildReport, guessColumns, looksSellable, ReportError } from './report';
import type { ShopifySnapshot } from './shopify';
import { staircase } from './timeline';

type Filter = 'all' | 'gaps' | 'judge' | 'agree' | 'none';

const ZONES = ['UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Singapore'];
const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (here && !ZONES.includes(here)) ZONES.splice(1, 0, here);

const st = {
  snapshot: null as ShopifySnapshot | null,
  snapshotName: '',
  table: null as Table | null,
  reportName: '',
  costs: new Map<string, Unit>(),
  costsName: '',
  costsNote: '',
  provider: '',
  skuCol: -1,
  qtyCol: -1,
  asOfCol: -1,
  whCol: -1,
  basis: 'on_hand' as 'on_hand' | 'sellable',
  zone: ZONES.includes(here) ? here : 'UTC',
  dayFirst: true,
  reportTime: '',
  sum: false,
  symbol: '£',
  locations: {} as Record<string, string>,
  answers: [] as Answer[],
  analysis: null as Analysis | null,
  notes: [] as string[],
  error: '',
  filter: 'all' as Filter,
  search: '',
  open: new Set<string>(),
  all: false,
  packOpen: false,
  demo: false,
  showFiles: false,
  skipCosts: false,
};

let token = 0;
let proof = '';
let violation = '';
const shown = new Map<string, number>();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function guessLocation(code: string): string {
  const locs = st.snapshot?.locations ?? [];
  const lc = code.toLowerCase();
  const words = st.provider.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const byCode = lc && locs.find((l) => l.name.toLowerCase().includes(lc));
  if (byCode) return byCode.id;
  const byName = locs.find((l) => words.some((w) => l.name.toLowerCase().includes(w)));
  if (byName) return byName.id;
  const notShop = locs.find((l) => l.isActive && !/shop|store|studio|retail|pop/i.test(l.name));
  return (notShop ?? locs[0])?.id ?? '';
}

function warehouseCodes(): string[] {
  if (!st.table) return [];
  if (st.whCol < 0) return [''];
  const seen = new Set<string>();
  for (const r of st.table.rows) seen.add((r[st.whCol] ?? '').trim());
  return [...seen];
}

function setDefaults() {
  if (!st.table) return;
  const g = guessColumns(st.table.headers);
  st.skuCol = g.sku;
  st.qtyCol = g.quantity[0] ?? -1;
  st.asOfCol = g.asOf;
  st.whCol = g.warehouse;
  if (st.qtyCol >= 0) st.basis = looksSellable(st.table.headers[st.qtyCol] ?? '') ? 'sellable' : 'on_hand';
  if (!st.provider) st.provider = st.reportName.replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'The 3PL';
  mapLocations();
}

function mapLocations() {
  const next: Record<string, string> = {};
  for (const c of warehouseCodes()) next[c] = st.locations[c] || guessLocation(c);
  st.locations = next;
}

async function refresh() {
  const mine = ++token;
  if (!st.snapshot || !st.table) {
    st.analysis = null;
    st.error = '';
    render();
    return;
  }
  try {
    if (st.skuCol < 0 || st.qtyCol < 0) throw new ReportError('Pick the SKU and quantity columns of the 3PL file.');
    const { report, notes } = buildReport(
      st.table,
      { skuCol: st.skuCol, qtyCol: st.qtyCol, asOfCol: st.asOfCol < 0 ? null : st.asOfCol, warehouseCol: st.whCol < 0 ? null : st.whCol, zone: st.zone, dayFirst: st.dayFirst, reportTime: st.reportTime || null, sumDuplicates: st.sum },
      st.provider || 'The 3PL',
      st.reportName || 'report',
    );
    const map: Record<string, string> = {};
    for (const [code, id] of Object.entries(st.locations)) if (code) map[code] = id;
    const a = await analyse({
      snapshot: st.snapshot,
      report,
      provider: st.provider || 'The 3PL',
      locationMap: map,
      defaultLocationId: st.locations[''] || undefined,
      basis: st.basis,
      costs: st.costs,
      answers: st.answers,
    });
    if (mine !== token) return;
    st.analysis = a;
    st.notes = notes;
    st.error = '';
  } catch (e) {
    if (mine !== token) return;
    st.analysis = null;
    st.error = readable(e instanceof Error ? e.message : String(e));
  }
  render();
}

function readable(message: string): string {
  const plain = message.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => when(new Date(iso)));
  if (/before orders were read/.test(plain)) {
    return plain.replace(/Fetch orders from before the report\.$/, 'Take a new snapshot that reads orders from before the report was taken.');
  }
  return plain;
}

async function readFile(f: File): Promise<string> {
  return await f.text();
}

async function takeFile(kind: 'snapshot' | 'report' | 'costs', f: File) {
  const text = await readFile(f);
  try {
    if (kind === 'snapshot') {
      const j = JSON.parse(text) as Partial<ShopifySnapshot>;
      if (!j || !Array.isArray(j.variants) || !Array.isArray(j.orders) || !Array.isArray(j.locations) || !j.fetchedAt || !j.ordersSince) {
        throw new Error('That does not look like a StockTruth Shopify snapshot. It needs variants, orders, locations, fetchedAt and ordersSince.');
      }
      st.snapshot = j as ShopifySnapshot;
      st.snapshotName = f.name;
    } else if (kind === 'report') {
      st.table = readTable(text);
      st.reportName = f.name;
      st.provider = '';
      setDefaults();
    } else {
      const r = readCosts(text);
      st.costs = r.units;
      st.costsName = f.name;
      st.costsNote = r.note;
    }
    if (kind === 'snapshot') mapLocations();
    st.demo = false;
    st.answers = [];
    st.error = '';
  } catch (e) {
    st.error = readable(e instanceof Error ? e.message : String(e));
    st.analysis = null;
    render();
    return;
  }
  await refresh();
}

function loadDemo() {
  st.snapshot = demoSnapshot as unknown as ShopifySnapshot;
  st.snapshotName = 'tern-and-co-demo snapshot';
  st.table = readTable(demoReport);
  st.reportName = 'demo-fulfilment-stock.csv';
  st.provider = 'Demo Fulfilment';
  const r = readCosts(demoCosts);
  st.costs = r.units;
  st.costsName = 'unit costs';
  st.costsNote = r.note;
  st.zone = 'Europe/London';
  st.sum = false;
  st.answers = [];
  setDefaults();
  st.qtyCol = guessColumns(st.table.headers).quantity[1] ?? st.qtyCol;
  st.basis = 'sellable';
  st.demo = true;
  st.open.clear();
  void refresh();
}

function reset() {
  Object.assign(st, { skipCosts: false, showFiles: false, snapshot: null, snapshotName: '', table: null, reportName: '', costs: new Map(), costsName: '', costsNote: '', provider: '', answers: [], analysis: null, error: '', notes: [], demo: false, reportTime: '' });
  st.open.clear();
  render();
}

// ---- rendering --------------------------------------------------------------

function drop(kind: 'snapshot' | 'report' | 'costs', title: string, what: string, got: string, accept: string): string {
  return `<div class="drop${got ? ' has' : ''}" data-drop="${kind}">
<b>${title}</b><span class="what">${what}</span>
${got ? `<span class="got">${esc(got)}</span>` : `<button class="pick" type="button">Choose a file</button>`}
<input type="file" accept="${accept}" data-file="${kind}" aria-label="${esc(title)}">
</div>`;
}

function filesBar(): string {
  const pill = (on: boolean, text: string) => `<span class="pill${on ? '' : ' off'}">${esc(text)}</span>`;
  return `<div class="files">${pill(true, `snapshot · ${plural(st.snapshot!.variants.length, 'variant')}, ${plural(st.snapshot!.orders.length, 'order')}`)}${pill(true, `${st.reportName || '3PL report'} · ${plural(st.table!.rows.length, 'row')}`)}${pill(Boolean(st.costsName), st.costsName ? `costs · ${st.costsNote}` : 'no costs, so units only')}
<button class="btn ghost sm" data-act="files" type="button">Change files</button><button class="btn ghost sm" data-act="demo" type="button">${st.demo ? 'Reload the demo' : 'Try the demo'}</button><button class="btn ghost sm" data-act="reset" type="button">Start again</button>${st.demo ? '<span style="color:var(--muted)">A made-up store with its problems planted on purpose.</span>' : ''}</div>`;
}

function loadHtml(): string {
  const ready = st.snapshot && st.table;
  if (ready && !st.showFiles && (st.costsName || st.skipCosts)) return filesBar();
  return `<div class="drops">
${drop('snapshot', '1. Shopify snapshot', 'A read-only snapshot of your store: stock levels, orders, refunds and transfers.', st.snapshot ? `${st.snapshotName} · ${plural(st.snapshot.variants.length, 'variant')}, ${plural(st.snapshot.orders.length, 'order')}` : '', '.json,application/json')}
${drop('report', '2. 3PL stock report', 'The CSV your warehouse sends: SKU, quantity and when it was taken.', st.table ? `${st.reportName} · ${plural(st.table.rows.length, 'row')}` : '', '.csv,.txt,text/csv')}
${drop('costs', '3. Unit costs (optional)', 'SKU and cost, or a Shopify product export. Without it, gaps are shown in units.', st.costsName ? `${st.costsName} · ${st.costsNote}` : '', '.csv,.txt,text/csv')}
</div>
<div class="row-actions">
<button class="btn${ready ? ' ghost' : ''}" data-act="demo" type="button">${ready ? 'Reload the demo store' : 'Try the demo store'}</button>
${ready ? `<button class="btn ghost" data-act="reset" type="button">Start again</button><button class="btn ghost" data-act="files" type="button">${st.costsName ? 'Done' : 'Continue without costs'}</button>` : ''}
<span class="what" style="color:var(--muted);font-size:13.5px">${st.demo ? 'A made-up store, with its problems planted on purpose.' : ''}</span>
</div>
${ready ? '' : `<details class="help"><summary>How do I get the Shopify snapshot?</summary>
<p>From the StockTruth repository, with a read-only app on your store:</p>
<pre>SHOPIFY_SHOP=your-store
SHOPIFY_CLIENT_ID=...  SHOPIFY_CLIENT_SECRET=...
THREEPL_REPORT=./report.csv  THREEPL_LOCATIONS="LEEDS=gid://shopify/Location/123"
ORDERS_SINCE=2026-09-21T00:00:00Z
SAVE_SNAPSHOT=snapshot.json
npm run demo:shopify --workspace packages/adapter-shopify</pre>
<p>Orders must be read from before the 3PL report was taken. The adapter refuses a report older than the orders it read.</p></details>`}`;
}

function selectCol(id: string, label: string, headers: string[], value: number, optional: boolean): string {
  const opts = headers.map((h, i) => `<option value="${i}"${i === value ? ' selected' : ''}>${esc(h || `column ${i + 1}`)}</option>`).join('');
  return `<label>${label}<select data-set="${id}">${optional ? `<option value="-1"${value < 0 ? ' selected' : ''}>none</option>` : ''}${opts}</select></label>`;
}

function setupHtml(): string {
  if (!st.snapshot || !st.table) return '';
  const h = st.table.headers;
  const locs = st.snapshot.locations;
  const codes = warehouseCodes();
  const summary = st.analysis
    ? `Reading it as: ${esc(h[st.skuCol] ?? '')} as SKU, ${esc(h[st.qtyCol] ?? '')} as quantity, ${st.basis === 'sellable' ? 'sellable' : 'on-hand'} stock, ${st.asOfCol >= 0 ? `times from ${esc(h[st.asOfCol] ?? '')} in ${esc(st.zone)}` : `taken at ${esc(st.reportTime || '?')}`}.`
    : 'Check how the 3PL file is read.';
  const mapRows = codes
    .map((c) => `<label>${c ? `Warehouse ${esc(c)} is` : 'Every row is at'}<select data-loc="${esc(c)}">${locs.map((l) => `<option value="${esc(l.id)}"${st.locations[c] === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>`)
    .join('');
  return `<details class="setup"${st.error ? ' open' : ''}><summary><span class="assumed">${summary}</span><span style="color:var(--muted)">Change</span></summary>
<div class="grid">
<label>The 3PL is called<input type="text" data-set="provider" value="${esc(st.provider)}"></label>
${selectCol('skuCol', 'SKU column', h, st.skuCol, false)}
${selectCol('qtyCol', 'Quantity column', h, st.qtyCol, false)}
${selectCol('asOfCol', 'Time column', h, st.asOfCol, true)}
${selectCol('whCol', 'Warehouse column', h, st.whCol, true)}
${mapRows}
<label>Compare on<select data-set="basis"><option value="on_hand"${st.basis === 'on_hand' ? ' selected' : ''}>Stock on hand (includes damaged)</option><option value="sellable"${st.basis === 'sellable' ? ' selected' : ''}>Sellable stock only</option></select></label>
<label>Times in the file are on<select data-set="zone">${ZONES.map((z) => `<option${z === st.zone ? ' selected' : ''}>${z}</option>`).join('')}</select></label>
<label>Report time, if the file has none<input type="datetime-local" data-set="reportTime" value="${esc(st.reportTime)}"></label>
<label>Dates are written<select data-set="dayFirst"><option value="1"${st.dayFirst ? ' selected' : ''}>day/month/year</option><option value="0"${st.dayFirst ? '' : ' selected'}>month/day/year</option></select></label>
<label>Currency symbol<input type="text" data-set="symbol" value="${esc(st.symbol)}" maxlength="3"></label>
<label class="check"><input type="checkbox" data-set="sum"${st.sum ? ' checked' : ''}> Add up SKUs that repeat (lots or bins)</label>
</div>
${st.notes.length ? `<p class="notes">${st.notes.map(esc).join(' ')}</p>` : ''}
</details>`;
}

function tween(key: string, value: number, format: (n: number) => string): string {
  return `<span data-tween="${key}" data-val="${value}" data-fmt="${key.startsWith('u:') ? 'units' : 'money'}">${format(value)}</span>`;
}

const KIND_ORDER: Record<Kind, number> = { overstated: 0, understated: 0, unsized: 1, unbooked: 2, uncounted: 3, agrees: 4 };

function heroHtml(a: Analysis): string {
  const o = a.overstated;
  const u = a.understated;
  const priced = a.valueBasis != null;
  const fmtM = (n: number) => money(n, st.symbol);
  const basis = a.valueBasis === 'cost' ? 'at cost' : a.valueBasis === 'price' ? 'at selling price' : '';
  const over = o.rows
    ? `<div><div class="big over">${priced && o.value != null ? tween('m:over', o.value, fmtM) : tween('u:over', o.units, (n) => units(n))}</div>
<div class="cap">${priced && o.value != null ? '' : 'units '}more in Shopify than the evidence supports${priced && o.unvalued ? `, plus ${plural(o.unvalued, 'SKU')} with no cost` : ''}</div></div>`
    : `<div><div class="big calm">No gaps found</div><div class="cap">Every SKU the 3PL counted agrees with Shopify${a.counts.unsized ? `, except ${plural(a.counts.unsized, 'SKU')} that cannot be judged yet` : ''}.</div></div>`;
  const under = u.rows
    ? `<div class="second"><div class="big">${priced && u.value != null ? tween('m:under', u.value, fmtM) : tween('u:under', u.units, (n) => units(n))}</div>
<div class="cap">${priced && u.value != null ? '' : 'units '}less in Shopify than the evidence supports</div></div>`
    : '';
  const places = [...new Set(a.rows.filter((r) => r.kind !== 'uncounted').map((r) => r.location))].join(', ');
  return `<section class="hero">${over}${under}
<div class="meta">${plural(o.rows + u.rows, 'SKU')} with a gap${basis ? `, ${basis}` : ''} · ${esc(places)} · Shopify read ${when(a.shopifyAt)}, 3PL report ${when(a.reportFrom)}${a.basis === 'sellable' ? ' · sellable stock' : ''}</div></section>
${statusLine(a)}${stripHtml(a)}`;
}

function statusLine(a: Analysis): string {
  const gaps = a.rows.filter((r) => r.kind === 'overstated' || r.kind === 'understated');
  if (!gaps.length) return '';
  const held = gaps.filter((r) => r.held).length;
  if (held) {
    const q = a.questions.filter((x) => x.mode === 'location').length;
    return `<div class="status"><span class="tag hold">Cause unknown</span><span>Shopify's API cannot show manual stock changes, so ${plural(held, 'gap')} cannot be blamed on either side yet.${q ? ` One question settles ${held === gaps.length ? 'all of them' : 'most of them'}.` : ''}</span></div>`;
  }
  return `<div class="status"><span class="tag stand">Stands on your word</span><span>These gaps hold only if what you told the page is true. Take an answer back and they go back to waiting.</span></div>`;
}

function stripHtml(a: Analysis): string {
  const c = a.counts;
  const total = a.rows.length || 1;
  const heldOver = a.rows.filter((r) => r.kind === 'overstated' && r.held).length;
  const heldUnder = a.rows.filter((r) => r.kind === 'understated' && r.held).length;
  const seg = (cls: string, n: number) => (n ? `<i class="${cls}" style="flex:${n}"></i>` : '');
  const leg = (n: number, text: string, color: string) => (n ? `<span><i style="background:${color}"></i><b>${n}</b>${text}</span>` : '');
  const hatch = heldOver + heldUnder > 0;
  return `<div class="strip" role="img" aria-label="${total} SKUs by status">${seg('s-agree', c.agrees)}${seg('s-overheld', heldOver)}${seg('s-over', c.overstated - heldOver)}${seg('s-underheld', heldUnder)}${seg('s-under', c.understated - heldUnder)}${seg('s-held', c.unsized)}${seg('s-none', c.uncounted + c.unbooked)}</div>
<div class="legend">${leg(c.agrees, 'agree', 'var(--ok)')}${leg(c.overstated, 'Shopify higher', 'var(--over)')}${leg(c.understated, 'Shopify lower', 'var(--under)')}${leg(c.unsized, 'cannot be judged', 'var(--held)')}${leg(c.uncounted + c.unbooked, 'not comparable', 'var(--faint)')}${hatch ? '<span style="color:var(--muted)">Hatched means the cause is still unknown.</span>' : ''}</div>`;
}

function questionHtml(q: Question, a: Analysis): string {
  const fmtM = (n: number) => money(n, st.symbol);
  const rows = q.rows.map((id) => a.rows.find((r) => r.id === id)!).filter(Boolean);
  const seen = new Map<string, { id: string; n: number }>();
  for (const r of rows) seen.set(r.sku, { id: seen.get(r.sku)?.id ?? r.id, n: (seen.get(r.sku)?.n ?? 0) + 1 });
  const skuList = [...seen.entries()];
  const list = skuList.slice(0, 8).map(([sku, v]) => `<button type="button" data-act="jump" data-row="${esc(v.id)}">${esc(sku)}${v.n > 1 ? ' x' + v.n : ''}</button>`).join(', ') + (skuList.length > 8 ? ` and ${skuList.length - 8} more` : '');
  const tally = q.value != null && a.valueBasis
    ? `${fmtM(q.value)} <span>of gaps ride on this answer</span> · ${plural(q.rows.length, 'SKU')} · ${plural(q.units, 'unit')}`
    : q.units ? `${plural(q.rows.length, 'SKU')} · ${plural(q.units, 'unit')} <span>ride on this answer</span>` : `${plural(q.rows.length, 'SKU')} <span>cannot be judged until this is fixed</span>`;
  let acts = '';
  if (q.mode === 'location') {
    acts = `<input type="text" data-note="${esc(q.id)}" placeholder="How did you check? (optional)" aria-label="How did you check">
<button class="btn" type="button" data-act="nochange" data-loc="${esc(q.locationId ?? '')}" data-q="${esc(q.id)}">Nothing was changed by hand</button>
<button class="btn ghost" type="button" data-act="jump" data-row="${esc(rows[0]?.id ?? '')}">Something was, tell me what</button>`;
  } else if (q.mode === 'adjustment') {
    acts = rows
      .flatMap((r) => r.adjustments.map((x) => ({ r, x })))
      .slice(0, 6)
      .map(({ r, x }) => adjustmentLine(r, x))
      .join('');
  }
  return `<div class="q ${q.mode === 'fix' ? 'fix' : ''}"><h3>${esc(q.headline)}</h3><p>${esc(q.detail)}</p>
<div class="tally tick">${tally}</div>
${q.mode === 'adjustment' ? acts : `<div class="acts">${acts}</div>`}
${q.mode === 'adjustment' ? '' : `<div class="rowlist">${list}</div>`}</div>`;
}

function adjustmentLine(r: Row, x: Row['adjustments'][number]): string {
  const key = `data-scope="${esc(r.id)}" data-move="${esc(x.id)}"`;
  return `<div class="adj"><span><b class="sku">${esc(r.sku)}</b> · ${esc(x.label)}, ${plural(x.quantity, 'unit')}${x.at ? ' at ' + clock(x.at) + ' UTC' : ''}<br><span class="small" style="color:var(--muted);font-size:13px">${esc(x.why)}</span></span>
<span class="acts"><button class="btn ghost sm" type="button" data-act="adjust" data-as="in" ${key}>Stock came in</button><button class="btn ghost sm" type="button" data-act="adjust" data-as="out" ${key}>Stock went out</button><button class="btn ghost sm" type="button" data-act="adjust" data-as="none" ${key}>Nothing moved</button></span></div>`;
}

function statusHtml(r: Row): string {
  const dot = `<i class="k-${r.kind}"></i>`;
  const word = r.onYourWord ? ' <span class="tag word">on your word</span>' : '';
  switch (r.kind) {
    case 'agrees':
      return `<span class="st">${dot}Agrees</span>`;
    case 'overstated':
      return `<span class="st">${dot}Shopify higher by ${r.gap == null ? '' : units(Math.abs(r.gap))}${r.held ? ' <span class="tag">waiting on an answer</span>' : word}</span>`;
    case 'understated':
      return `<span class="st">${dot}Shopify lower by ${r.gap == null ? '' : units(Math.abs(r.gap))}${r.held ? ' <span class="tag">waiting on an answer</span>' : word}</span>`;
    case 'unsized':
      return `<span class="st">${dot}Cannot be judged <span class="tag">${esc(r.blockers[0]?.short ?? 'see why')}</span></span>`;
    case 'uncounted':
      return `<span class="st">${dot}Not in the 3PL report</span>`;
    default:
      return `<span class="st">${dot}3PL holds it, no Shopify level here</span>`;
  }
}

function caseHtml(r: Row): string {
  const net = r.steps.filter((s) => s.insideBook).reduce((n, s) => n + s.signed, 0);
  const shipped = r.steps.filter((s) => s.insideBook && s.signed < 0).reduce((n, s) => n - s.signed, 0);
  const back = r.steps.filter((s) => s.insideBook && s.signed > 0).reduce((n, s) => n + s.signed, 0);
  const caption = r.count != null && r.countAt
    ? `The 3PL counted <b>${units(r.count)}</b> at ${clock(r.countAt)} UTC. ${r.steps.length ? `${plural(shipped, 'unit')} left since${back ? ` and ${plural(back, 'unit')} came back` : ''} (net ${signed(net)}).` : 'Nothing moved since.'}`
    : '';
  const chart = staircase(r);
  const reported = r.unplaced.length
    ? `<p class="small" style="margin-top:6px"><b>Manual change: ${signed(r.unplaced.reduce((n, u) => n + u.units, 0))} units, exact time unknown.</b> Reported by you, and known only to have happened between the count and Shopify's figure, so it is drawn as a span and not as a point.${r.unplaced.some((u) => u.note) ? ' ' + esc(r.unplaced.map((u) => u.note).filter(Boolean).join('; ')) : ''}</p>`
    : '';
  let right = '';
  if (r.gap != null && r.gap !== 0 && r.evidence != null && r.book != null) {
    const dir = r.gap < 0 ? 'more' : 'fewer';
    right += `<h4>Shopify holds ${units(Math.abs(r.gap))} ${dir} than the evidence supports</h4>
<p>Evidence is the count carried forward through every shipment and return Shopify recorded: <b>${r.evidence}</b>. Shopify says <b>${r.book}</b>.${r.value != null ? ` At ${st.symbol}${r.unitValue?.toFixed(2)} each that is <b>${money(r.value, st.symbol)}</b>.` : ''}</p>`;
  } else if (r.kind === 'agrees') {
    right += `<h4>The evidence agrees with Shopify</h4><p>The 3PL's count, carried forward through every recorded movement${r.unplaced.length ? ' and the change you reported' : ''}, lands on Shopify's figure of <b>${r.book}</b>.</p>`;
  } else if (r.kind === 'unsized') {
    right += `<h4>No honest figure can be given yet</h4>`;
  } else if (r.kind === 'uncounted') {
    right += `<h4>The 3PL report does not cover this</h4><p>Shopify holds ${r.book ?? '?'} here. Nobody has counted it in this comparison, so there is nothing to check it against.</p>`;
  }
  if (r.held || r.kind === 'unsized') {
    right += `<ul>${r.blockers.map((b) => `<li>${esc(b.resolution)}</li>`).join('')}</ul>`;
  }
  if (r.ifCleared && r.ifCleared.quantity != null && r.ifCleared.assuming.length) {
    right += `<p class="small">If every blocker cleared the most favourable way: ${r.ifCleared.quantity}, assuming ${esc(r.ifCleared.assuming.join('; '))}.</p>`;
  }
  if (r.blockers.some((b) => b.code === 'BOOK_GAP_UNATTRIBUTABLE') && r.gap != null && r.gap !== 0) {
    const sugg = r.gap < 0 ? 'in' : 'out';
    right += `<div class="formbox"><h4>Something changed by hand?</h4>
<p class="small">${r.gap < 0 ? `Shopify is higher, so a hand-entered receipt or increase of ${Math.abs(r.gap)} would explain it.` : `Shopify is lower, so a hand-entered removal of ${Math.abs(r.gap)} would explain it.`}</p>
<div class="formrow"><select data-f="direction" aria-label="Direction"><option value="in"${sugg === 'in' ? ' selected' : ''}>added</option><option value="out"${sugg === 'out' ? ' selected' : ''}>removed</option></select>
<input type="number" min="1" data-f="units" value="${Math.abs(r.gap)}" aria-label="Units"> units
<label><input type="checkbox" data-f="only" checked> nothing else</label></div>
<div class="formrow"><input type="text" data-f="note" placeholder="How do you know? (optional)">
<button class="btn sm" type="button" data-act="change" data-scope="${esc(r.id)}">Apply this answer</button></div></div>`;
  }
  if (r.adjustments.length && r.held) {
    right += `<div class="formbox"><h4>What did this record?</h4>${r.adjustments.map((x) => adjustmentLine(r, x)).join('')}</div>`;
  }
  const key = r.count != null ? `<div class="keyline"><span><i style="background:var(--ink)"></i>3PL count</span><span><i style="background:transparent;border:2px solid var(--ink-2)"></i>each shipment or return</span>${r.unplaced.length ? '<span><i style="background:transparent;border:2px dashed var(--mark)"></i>your answer, time unknown</span>' : ''}<span><i style="background:transparent;border:3px solid var(--mark)"></i>Shopify's figure</span>${r.gap ? `<span><i style="background:var(--ink)"></i>what the evidence supports</span>` : ''}</div>` : '';
  return `<div class="in"><div>${chart}${key}<p class="small" style="margin-top:10px">${caption}</p>${reported}</div><div>${right}</div></div>`;
}

function rowsHtml(a: Analysis): string {
  const f = st.filter;
  const q = st.search.trim().toLowerCase();
  let rows = a.rows.filter((r) => {
    if (f === 'gaps' && !(r.kind === 'overstated' || r.kind === 'understated')) return false;
    if (f === 'judge' && r.kind !== 'unsized') return false;
    if (f === 'agree' && r.kind !== 'agrees') return false;
    if (f === 'none' && !(r.kind === 'uncounted' || r.kind === 'unbooked')) return false;
    return !q || r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
  });
  rows = [...rows].sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (y.value ?? -1) - (x.value ?? -1) || Math.abs(y.gap ?? 0) - Math.abs(x.gap ?? 0) || x.sku.localeCompare(y.sku));
  const limit = st.all ? rows.length : 80;
  const chips: [Filter, string][] = [['all', `All ${a.rows.length}`], ['gaps', `Gaps ${a.counts.overstated + a.counts.understated}`], ['judge', `Cannot be judged ${a.counts.unsized}`], ['agree', `Agree ${a.counts.agrees}`], ['none', `Not comparable ${a.counts.uncounted + a.counts.unbooked}`]];
  const body = rows
    .slice(0, limit)
    .map((r) => {
      const open = st.open.has(r.id);
      return `<tr class="r" tabindex="0" role="button" aria-expanded="${open}" data-row="${esc(r.id)}">
<td><span class="sku">${esc(r.sku)}</span><span class="nm">${esc(r.name)}${a.rows.filter((x) => x.sku === r.sku).length > 1 ? ' · ' + esc(r.location) : ''}</span></td>
<td>${statusHtml(r)}</td>
<td class="n">${r.count == null ? '' : units(r.count)}</td><td class="n">${r.evidence == null ? '' : units(r.evidence)}</td><td class="n">${r.book == null ? '' : units(r.book)}</td>
<td class="n">${r.value != null ? money(r.value, st.symbol) : ''}</td></tr>
<tr class="case" data-case="${esc(r.id)}"${open ? '' : ' hidden'}><td colspan="6">${open ? caseHtml(r) : ''}</td></tr>`;
    })
    .join('');
  return `<div class="tools" role="group" aria-label="Filter">${chips.map(([k, t]) => `<button class="chip" type="button" data-filter="${k}" aria-pressed="${f === k}">${t}</button>`).join('')}<input type="search" data-search placeholder="Find a SKU" value="${esc(st.search)}" aria-label="Find a SKU"></div>
<table class="rows"><thead><tr><th>Item</th><th>Status</th><th class="n">3PL count</th><th class="n">Evidence</th><th class="n">Shopify</th><th class="n">${a.valueBasis ? 'Value' : ''}</th></tr></thead><tbody>${body || `<tr><td colspan="6" style="color:var(--muted);padding:22px 10px">Nothing matches.</td></tr>`}</tbody></table>
${rows.length > limit ? `<div class="more"><button class="btn ghost sm" type="button" data-act="all">Show all ${rows.length}</button></div>` : ''}
<p class="sub" style="margin-top:14px">Evidence is the 3PL count carried forward through every shipment, return and transfer Shopify recorded since, up to the moment of Shopify's figure.</p>`;
}

function outsideHtml(a: Analysis): string {
  if (!a.outside.length) return '';
  const list = a.outside.map((f) => `<li><span>${esc(f.text)}</span>${f.value != null && a.valueBasis ? `<b>${money(f.value, st.symbol)}</b>` : f.units != null ? `<b>${plural(f.units, 'unit')}</b>` : ''}</li>`).join('');
  return `<h2>Outside the numbers</h2><p class="sub">Things the comparison cannot score but a person should see.</p><ul class="out">${list}</ul>`;
}

function answersHtml(a: Analysis): string {
  if (!st.answers.length) return '';
  const label = (x: Answer): string => {
    if (x.kind === 'no-changes') return `Nothing was changed by hand at ${esc(a.rows.find((r) => r.locationId === x.locationId)?.location ?? 'the location')}`;
    const sku = a.rows.find((r) => r.id === x.scopeId)?.sku ?? '';
    if (x.kind === 'change') return `${esc(sku)}: ${x.direction === 'in' ? '+' : '-'}${units(x.units)} by hand, exact time unknown, somewhere between the count and Shopify's figure${x.only ? '; nothing else' : ''}`;
    return `${esc(sku)}: adjustment was ${x.as === 'in' ? 'stock coming in' : x.as === 'out' ? 'stock going out' : 'nothing moving'}`;
  };
  return `<div class="word"><span><b>${plural(st.answers.length, 'answer')}</b> from you shape these figures. Anything marked "on your word" depends on them.</span></div>
<div class="answers">${st.answers.map((x, i) => `<div><span>${label(x)}${x.note ? ` <span style="color:var(--muted)">(${esc(x.note)})</span>` : ''}</span><button class="btn ghost sm" type="button" data-act="undo" data-i="${i}">Take back</button></div>`).join('')}</div>`;
}

function resultsHtml(): string {
  if (st.error) return `<div class="error" role="alert">${esc(st.error)}</div>`;
  const a = st.analysis;
  if (!a) return '';
  const qs = a.questions.map((q) => questionHtml(q, a)).join('');
  return `${heroHtml(a)}${answersHtml(a)}
<h2>${a.questions.length ? 'Questions, biggest first' : 'Nothing is waiting on an answer'}${a.questions.length ? `<small>${plural(a.questions.length, 'question')}</small>` : ''}</h2>
${a.questions.length ? `<p class="sub">Each one clears every SKU listed under it. Answer from what you know; nothing is assumed for you.</p>${qs}` : ''}
<h2>Every SKU</h2>
${rowsHtml(a)}
${outsideHtml(a)}
<div class="row-actions" style="margin-top:40px"><button class="btn" type="button" data-act="pack">Open the evidence pack</button><button class="btn ghost" type="button" data-act="csv">Download as CSV</button></div>`;
}

function render() {
  $('load').innerHTML = loadHtml();
  $('setup').innerHTML = setupHtml();
  $('results').innerHTML = resultsHtml();
  $('intro').hidden = Boolean(st.snapshot && st.table);
  $('proof').textContent = proof;
  const a = st.analysis;
  const pack = $('pack');
  pack.hidden = !(st.packOpen && a);
  if (st.packOpen && a) $('paper').innerHTML = packHtml(a, st.answers, st.symbol);
  runTweens();
}

function runTweens() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll<HTMLElement>('[data-tween]').forEach((el) => {
    const key = el.dataset.tween!;
    const to = Number(el.dataset.val);
    const from = shown.get(key);
    shown.set(key, to);
    const fmt = (n: number) => (el.dataset.fmt === 'units' ? units(Math.round(n)) : money(n, st.symbol));
    if (from == null || from === to || reduced) return;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 550);
      const eased = 1 - (1 - p) ** 3;
      el.textContent = fmt(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---- events -----------------------------------------------------------------

function answer(a: Answer) {
  st.answers.push(a);
  void refresh();
}

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function save(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

function toggleCase(id: string, forceOpen = false) {
  const tr = document.querySelector<HTMLElement>(`tr.case[data-case="${CSS.escape(id)}"]`);
  const head = document.querySelector<HTMLElement>(`tr.r[data-row="${CSS.escape(id)}"]`);
  if (!tr || !head || !st.analysis) return;
  const open = forceOpen ? true : tr.hidden;
  tr.hidden = !open;
  head.setAttribute('aria-expanded', String(open));
  if (open) {
    st.open.add(id);
    const row = st.analysis.rows.find((r) => r.id === id);
    if (row && !tr.firstElementChild!.innerHTML) tr.firstElementChild!.innerHTML = caseHtml(row);
  } else st.open.delete(id);
}

function jump(id: string) {
  if (!st.analysis) return;
  const row = st.analysis.rows.find((r) => r.id === id);
  if (!row) return;
  st.filter = 'all';
  st.search = '';
  st.all = true;
  st.open.add(id);
  $('results').innerHTML = resultsHtml();
  document.querySelector(`tr.r[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}

function wire() {
  document.addEventListener('securitypolicyviolation', (e) => {
    violation = e.violatedDirective;
  });

  document.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t instanceof HTMLInputElement && t.dataset.file) {
      const f = t.files?.[0];
      if (f) void takeFile(t.dataset.file as 'snapshot' | 'report' | 'costs', f);
      return;
    }
    if (t.dataset.loc !== undefined) {
      st.locations[t.dataset.loc] = t.value;
      void refresh();
      return;
    }
    const key = t.dataset.set;
    if (!key) return;
    const v = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value;
    if (key === 'provider') st.provider = String(v);
    else if (key === 'symbol') st.symbol = String(v) || '£';
    else if (key === 'basis') st.basis = v === 'sellable' ? 'sellable' : 'on_hand';
    else if (key === 'zone') st.zone = String(v);
    else if (key === 'reportTime') st.reportTime = String(v);
    else if (key === 'dayFirst') st.dayFirst = v === '1';
    else if (key === 'sum') st.sum = Boolean(v);
    else {
      (st as unknown as Record<string, number>)[key] = Number(v);
      if (key === 'whCol') mapLocations();
      if (key === 'qtyCol' && st.table) st.basis = looksSellable(st.table.headers[st.qtyCol] ?? '') ? 'sellable' : st.basis;
    }
    void refresh();
  });

  document.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.search !== undefined) {
      st.search = t.value;
      $('results').innerHTML = resultsHtml();
      const box = document.querySelector<HTMLInputElement>('[data-search]');
      box?.focus();
      box?.setSelectionRange(t.value.length, t.value.length);
    }
  });

  for (const ev of ['dragover', 'dragleave', 'drop'] as const) {
    document.addEventListener(ev, (e) => {
      const z = (e.target as HTMLElement).closest?.<HTMLElement>('[data-drop]');
      if (!z) return;
      e.preventDefault();
      z.classList.toggle('over', ev === 'dragover');
      if (ev === 'drop') {
        const f = (e as DragEvent).dataTransfer?.files?.[0];
        if (f) void takeFile(z.dataset.drop as 'snapshot' | 'report' | 'costs', f);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.packOpen) {
      st.packOpen = false;
      render();
    }
    const tr = (e.target as HTMLElement).closest?.<HTMLElement>('tr.r');
    if (tr && (e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement) === tr) {
      e.preventDefault();
      toggleCase(tr.dataset.row!);
    }
  });

  document.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const filter = el.closest<HTMLElement>('[data-filter]');
    if (filter) {
      st.filter = filter.dataset.filter as Filter;
      $('results').innerHTML = resultsHtml();
      return;
    }
    const btn = el.closest<HTMLElement>('[data-act]');
    if (!btn) {
      const tr = el.closest<HTMLElement>('tr.r');
      if (tr) toggleCase(tr.dataset.row!);
      return;
    }
    const act = btn.dataset.act!;
    if (act === 'demo') {
      st.showFiles = false;
      loadDemo();
    } else if (act === 'files') {
      const collapsed = Boolean(st.snapshot && st.table) && !st.showFiles && (st.costsName || st.skipCosts);
      st.showFiles = Boolean(collapsed);
      if (!collapsed) st.skipCosts = true;
      render();
    } else if (act === 'reset') reset();
    else if (act === 'all') {
      st.all = true;
      $('results').innerHTML = resultsHtml();
    } else if (act === 'jump') jump(btn.dataset.row!);
    else if (act === 'nochange') {
      const note = document.querySelector<HTMLInputElement>(`[data-note="${CSS.escape(btn.dataset.q!)}"]`)?.value.trim() ?? '';
      answer({ kind: 'no-changes', locationId: btn.dataset.loc!, note, at: now() });
    } else if (act === 'change') {
      const box = btn.closest('.formbox')!;
      const get = (k: string) => box.querySelector<HTMLInputElement>(`[data-f="${k}"]`)!;
      const n = Math.round(Number(get('units').value));
      if (!(n > 0)) return;
      answer({ kind: 'change', scopeId: btn.dataset.scope!, direction: get('direction').value === 'out' ? 'out' : 'in', units: n, only: get('only').checked, note: get('note').value.trim(), at: now() });
    } else if (act === 'adjust') {
      answer({ kind: 'adjustment', scopeId: btn.dataset.scope!, movementId: btn.dataset.move!, as: btn.dataset.as as 'in' | 'out' | 'none', note: '', at: now() });
    } else if (act === 'undo') {
      st.answers.splice(Number(btn.dataset.i), 1);
      void refresh();
    } else if (act === 'pack') {
      st.packOpen = true;
      render();
    } else if (act === 'close') {
      st.packOpen = false;
      render();
    } else if (act === 'print') window.print();
    else if (act === 'copy' && st.analysis) {
      const ok = await copy(packMessage(st.analysis, st.symbol));
      btn.textContent = ok ? 'Copied' : 'Select and copy failed';
      setTimeout(() => (btn.textContent = 'Copy as a message'), 1800);
    } else if (act === 'csv' && st.analysis) save('stock-check.csv', csvOut(st.analysis), 'text/csv');
    else if (act === 'html' && st.analysis) {
      save('stock-check.html', `<!doctype html><meta charset="utf-8"><title>Stock check</title><style>${PAPER_CSS}</style>${packHtml(st.analysis, st.answers, st.symbol)}`, 'text/html');
    } else if (act === 'prove') {
      violation = '';
      proof = 'Trying to reach the internet...';
      $('proof').textContent = proof;
      try {
        await fetch('https://example.com/stocktruth-test', { mode: 'no-cors' });
        proof = 'The request was not blocked. Do not use this page with real data.';
      } catch {
        await new Promise((r) => setTimeout(r, 60));
        proof = violation
          ? `Blocked by this page's own security policy (${violation}). Nothing can leave it.`
          : 'The request failed, but the page could not confirm why.';
      }
      $('proof').textContent = proof;
    }
  });
}

const PAPER_CSS = `body{font:14px/1.55 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 24px;color:#23201a}h2{font-size:26px}h3{font-size:15px;margin-top:28px;border-top:1px solid #cfc4a3;padding-top:14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:7px 8px;border-bottom:1px solid #cfc4a3;text-align:left;vertical-align:top}td.n,th:not(:first-child){text-align:right;font-family:ui-monospace,monospace}.p-meta{font-family:ui-monospace,monospace;font-size:12.5px;color:#51493a}.p-sub,.p-small{font-size:12.5px;color:#6a604b}`;

function shell() {
  document.body.innerHTML = `<div class="wrap">
<div class="top"><div class="brand">StockTruth<span>Shopify against your 3PL</span></div>
<div class="lock"><span>Runs in this page. Nothing is uploaded.</span><button type="button" data-act="prove">Try to send something</button><span id="proof" class="verdict" role="status"></span></div></div>
<div id="intro"><h1>Is Shopify's stock figure true?</h1>
<p class="lede">Drop in a snapshot of your store and your warehouse's stock report. You get the gaps, the ones nobody can judge yet, and the one question that clears the most of them.</p></div>
<div id="load"></div><div id="setup"></div><div id="results"></div>
<div class="foot"><span>StockTruth 0.6.0 · engine ${ENGINE_VERSION}</span><span>A refused number is never a zero. Where the evidence cannot support an answer, this says so.</span></div></div>
<div class="overlay" id="pack" hidden><div class="bar"><button class="btn" type="button" data-act="print">Print or save as PDF</button><button class="btn ghost" type="button" data-act="copy">Copy as a message</button><button class="btn ghost" type="button" data-act="html">Download as a page</button><button class="btn ghost" type="button" data-act="close">Close</button></div><div id="paper"></div></div>`;
}

shell();
wire();
render();
