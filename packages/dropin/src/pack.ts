import type { Analysis, Answer, Row } from './analyse';
import { clock, esc, money, plural, signed, units, when } from './format';

function side(row: Row): string {
  if (row.diff == null || row.diff === 0) return '';
  return row.diff > 0 ? 'Shopify higher' : 'Shopify lower';
}

function shippedSince(row: Row): number {
  return row.steps.filter((s) => s.insideBook && s.signed < 0).reduce((n, s) => n - s.signed, 0);
}

function returnedSince(row: Row): number {
  return row.steps.filter((s) => s.insideBook && s.signed > 0).reduce((n, s) => n + s.signed, 0);
}

export function gapRows(a: Analysis): Row[] {
  return a.rows
    .filter((r) => r.kind === 'overstated' || r.kind === 'understated')
    .sort((x, y) => (y.value ?? 0) - (x.value ?? 0) || Math.abs(y.gap ?? 0) - Math.abs(x.gap ?? 0));
}

function answerLine(x: Answer, a: Analysis): string {
  const place = (id: string) => a.rows.find((r) => r.id === id);
  const note = x.note ? ` Note: ${x.note}` : '';
  if (x.kind === 'no-changes') return `No manual changes were made at ${a.rows.find((r) => r.locationId === x.locationId)?.location ?? 'the location'} since the report.${note}`;
  if (x.kind === 'change') return `${place(x.scopeId)?.sku ?? 'An item'}: manual change of ${x.direction === 'in' ? '+' : '-'}${units(x.units)} units, exact time unknown; known to have occurred within the comparison interval${x.only ? ', and nothing else changed' : ''}.${note}`;
  const what = x.as === 'in' ? 'stock came in' : x.as === 'out' ? 'stock went out' : 'nothing moved';
  return `${place(x.scopeId)?.sku ?? 'An item'}: an adjustment recorded as unknown was confirmed as: ${what}.${note}`;
}

function summaryText(a: Analysis, symbol: string): string {
  const parts: string[] = [];
  const o = a.overstated;
  const u = a.understated;
  const at = a.valueBasis ? ` (${money(o.value ?? 0, symbol)} at ${a.valueBasis === 'cost' ? 'cost' : 'selling price'})` : '';
  if (o.rows) parts.push(`Shopify holds ${plural(o.units, 'unit')} more than the ${a.provider} report supports across ${plural(o.rows, 'SKU')}${at}.`);
  if (u.rows) {
    const t = a.valueBasis ? ` (${money(u.value ?? 0, symbol)})` : '';
    parts.push(`It holds ${plural(u.units, 'unit')} fewer across ${plural(u.rows, 'SKU')}${t}.`);
  }
  parts.push(`${plural(a.counts.agrees, 'SKU')} agree. ${plural(a.counts.unsized, 'SKU')} cannot be judged until something is fixed.`);
  return parts.join(' ');
}

export function packHtml(a: Analysis, answers: Answer[], symbol: string): string {
  const gaps = gapRows(a);
  const priced = a.valueBasis != null;
  const rows = gaps
    .map(
      (r) => `<tr>
<td><b>${esc(r.sku)}</b><br><span class="p-sub">${esc(r.name)}</span></td>
<td class="n">${units(r.count ?? 0)}<br><span class="p-sub">${r.countAt ? clock(r.countAt) + ' UTC' : ''}</span></td>
<td class="n">${units(shippedSince(r))} out${returnedSince(r) ? ` / ${units(returnedSince(r))} in` : ''}${r.unplaced.length ? `<br><span class="p-sub">${signed(r.unplaced.reduce((n, u) => n + u.units, 0))} by hand, time unknown</span>` : ''}</td>
<td class="n">${r.evidence ?? ''}</td>
<td class="n">${r.book ?? ''}<br><span class="p-sub">${r.bookAt ? clock(r.bookAt) + ' UTC' : ''}</span></td>
<td class="n"><b>${r.diff == null ? '' : signed(r.diff)}</b><br><span class="p-sub">${side(r)}</span></td>
${priced ? `<td class="n">${r.value == null ? 'no cost' : money(r.value, symbol)}</td>` : ''}
</tr>`,
    )
    .join('');

  const questions = a.questions
    .map((q, i) => `<li><b>${esc(q.headline)}</b><br>${esc(q.detail)}<br><span class="p-sub">${q.rows.length} ${q.rows.length === 1 ? 'item' : 'items'}${q.value != null && a.valueBasis ? `, ${money(q.value, symbol)} held on this answer` : ''}.</span></li>`)
    .join('');

  const outside = a.outside.filter((f) => f.units != null).map((f) => `<li>${esc(f.text)}</li>`).join('');
  const given = answers.map((x) => `<li>${esc(answerLine(x, a))} <span class="p-sub">Recorded ${esc(x.at.slice(0, 16).replace('T', ' '))} UTC.</span></li>`).join('');

  return `<article class="paper">
<header>
<h2>Stock check: Shopify against ${esc(a.provider)}</h2>
<p class="p-meta">${esc(a.shop)}<br>
${esc(a.provider)} report: ${when(a.reportFrom)}${a.reportTo.getTime() !== a.reportFrom.getTime() ? ' to ' + when(a.reportTo) : ''}<br>
Shopify read: ${when(a.shopifyAt)}<br>
Compared on ${a.basis === 'sellable' ? 'sellable stock (damaged and quality control left out)' : 'stock on hand'}</p>
</header>
<p class="p-lead">${esc(summaryText(a, symbol))}</p>
<p class="p-small">This is a request to check, not a finding of fault. A gap can be real loss, or a change Shopify's API cannot show.</p>
${gaps.length ? `<h3>Gaps</h3>
<table class="p-table"><thead><tr><th>Item</th><th>3PL count</th><th>Moved since</th><th>Evidence supports</th><th>Shopify says</th><th>Shopify minus evidence</th>${priced ? '<th>Value</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
<p class="p-small">Evidence supports = the 3PL count plus every shipment, return and transfer Shopify recorded after it, up to the moment of Shopify's figure.</p>` : ''}
${questions ? `<h3>What needs checking</h3><ol class="p-q">${questions}</ol>` : ''}
${outside ? `<h3>Also noticed</h3><ul class="p-q">${outside}</ul>` : ''}
${given ? `<h3>Answers given while preparing this</h3><ul class="p-q">${given}</ul><p class="p-small">These were entered by the person preparing the sheet. They have not been verified, and every figure marked on their word depends on them.</p>` : ''}
</article>`;
}

export function packMessage(a: Analysis, symbol: string): string {
  const gaps = gapRows(a).slice(0, 15);
  const lines = [
    `Hi,`,
    ``,
    `I compared your stock report from ${when(a.reportFrom)} with what Shopify held at ${when(a.shopifyAt)}, allowing for every order, return and transfer in between.`,
    ``,
    summaryText(a, symbol),
    ``,
  ];
  if (gaps.length) {
    lines.push('The largest gaps:');
    for (const r of gaps) {
      lines.push(`- ${r.sku}: your count ${r.count}, ${units(shippedSince(r))} shipped since, so ${r.evidence} expected; Shopify says ${r.book} (${signed(r.diff ?? 0)})`);
    }
    lines.push('');
  }
  lines.push('Could you confirm whether anything was received, returned, adjusted or moved after the report that is not in it? A list of any manual stock changes since then would settle most of these.');
  const fixes = a.questions.filter((q) => q.mode !== 'location');
  if (fixes.length) {
    lines.push('', 'Two other things I could not resolve from my side:');
    for (const q of fixes.slice(0, 4)) lines.push(`- ${q.headline}`);
  }
  lines.push('', 'Thanks');
  return lines.join('\n');
}

export function csv(a: Analysis): string {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['sku', 'name', 'location', 'status', 'threepl_count', 'counted_at_utc', 'evidence_now', 'shopify', 'shopify_at_utc', 'shopify_minus_evidence', 'unit_value', 'value', 'on_your_word', 'what_blocks_it'];
  const lines = a.rows.map((r) =>
    [r.sku, r.name, r.location, r.kind, r.count, r.countAt?.toISOString(), r.evidence, r.book, r.bookAt?.toISOString(), r.diff, r.unitValue, r.value == null ? '' : r.value.toFixed(2), r.onYourWord ? 'yes' : '', r.blockers.map((b) => b.short).join('; ')].map(cell).join(','),
  );
  return [head.join(','), ...lines].join('\n') + '\n';
}
