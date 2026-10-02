import type { Row } from './analyse';
import { clock, esc, signed } from './format';

const W = 760;
const H = 250;
const M = { l: 58, r: 62, t: 26, b: 46 };

function niceStep(span: number): number {
  const steps = [15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60000);
  return steps.find((s) => span / s <= 6) ?? steps[steps.length - 1]!;
}

function niceTicks(lo: number, hi: number): number[] {
  const span = Math.max(1, hi - lo);
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

// the count walked forward through every recorded shipment and return, with
// shopify's own figure floating where it landed
export function staircase(row: Row): string {
  if (!row.count || !row.countAt) return '';
  const t0 = row.countAt.getTime();
  const steps = row.steps;
  const reported = row.unplaced.reduce((n, u) => n + u.units, 0);
  const top = reported ? M.t + 26 : M.t;
  const bookAt = row.bookAt?.getTime() ?? null;
  const tEnd = Math.max(bookAt ?? t0, steps.length ? steps[steps.length - 1]!.at.getTime() : t0, t0 + 30 * 60000);
  const pad = Math.max(10 * 60000, (tEnd - t0) * 0.04);
  const x0 = t0 - pad;
  const x1 = tEnd + pad;
  const X = (t: number) => M.l + ((t - x0) / (x1 - x0)) * (W - M.l - M.r);

  const running: number[] = [];
  let q = row.count;
  for (const s of steps) {
    if (s.insideBook) q += s.signed;
    running.push(q);
  }
  const expected = row.evidence;
  const values = [row.count, ...running, ...(row.book != null ? [row.book] : []), ...(expected != null ? [expected] : [])];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const room = Math.max(3, Math.ceil((hi - lo) * 0.18));
  lo = Math.max(0, lo - room);
  hi += room;
  const Y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (H - top - M.b);

  let d = `M ${X(t0).toFixed(1)} ${Y(row.count).toFixed(1)}`;
  let level = row.count;
  const dots: string[] = [];
  steps.forEach((s, i) => {
    const x = X(s.at.getTime());
    d += ` H ${x.toFixed(1)}`;
    if (s.insideBook) {
      level += s.signed;
      d += ` V ${Y(level).toFixed(1)}`;
    }
    dots.push(
      `<circle class="st-dot${s.insideBook ? '' : ' st-late'}" cx="${x.toFixed(1)}" cy="${Y(running[i]!).toFixed(1)}" r="3.5"><title>${esc(s.label)}: ${signed(s.signed)} at ${clock(s.at)} UTC</title></circle>`,
    );
  });
  const endX = X(bookAt ?? tEnd);
  d += ` H ${endX.toFixed(1)}`;
  const arrived = running.length ? running[running.length - 1]! : row.count;

  const tick = niceStep(x1 - x0);
  const axis: string[] = [];
  for (let t = Math.ceil(x0 / tick) * tick; t <= x1; t += tick) {
    axis.push(`<line class="st-grid" x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${top}" y2="${H - M.b}"/><text class="st-axis" x="${X(t).toFixed(1)}" y="${H - M.b + 18}" text-anchor="middle">${clock(new Date(t))}</text>`);
  }
  const yAxis = niceTicks(lo, hi).map(
    (v) => `<line class="st-grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="st-axis" x="${M.l - 10}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`,
  );

  let marks = `<circle class="st-count" cx="${X(t0).toFixed(1)}" cy="${Y(row.count).toFixed(1)}" r="6"/>` +
    `<text class="st-note" x="${(X(t0) + 4).toFixed(1)}" y="${(Y(row.count) - 12).toFixed(1)}">${row.count}</text>`;

  let aria = `3PL count ${row.count} at ${clock(row.countAt)} UTC`;
  if (reported) {
    // told what changed and not when, so it is drawn as a span over the whole
    // interval and a dashed step off the end of the line, never as a point in time
    const bx0 = X(t0);
    const bx1 = endX;
    const by = top - 16;
    marks +=
      `<path class="st-band" d="M ${bx0.toFixed(1)} ${(by + 6).toFixed(1)} V ${by.toFixed(1)} H ${bx1.toFixed(1)} V ${(by + 6).toFixed(1)}"/>` +
      `<text class="st-bandtext" x="${((bx0 + bx1) / 2).toFixed(1)}" y="${(by - 7).toFixed(1)}" text-anchor="middle">${esc(`reported by hand: ${signed(reported)}, time unknown`)}</text>` +
      `<line class="st-unplaced" x1="${endX.toFixed(1)}" x2="${endX.toFixed(1)}" y1="${Y(arrived).toFixed(1)}" y2="${Y(arrived + reported).toFixed(1)}"/>`;
    aria += `, ${signed(reported)} reported by hand at an unknown time within the interval`;
  }
  if (row.book != null && bookAt != null) {
    const bx = X(bookAt);
    marks += `<circle class="st-book" cx="${bx.toFixed(1)}" cy="${Y(row.book).toFixed(1)}" r="6.5"/>` +
      `<text class="st-note" x="${(bx + 12).toFixed(1)}" y="${(Y(row.book) + 4).toFixed(1)}">${row.book}</text>`;
    aria += `, Shopify ${row.book} at ${clock(row.bookAt!)} UTC`;
    if (expected != null && row.gap) {
      const cls = row.gap < 0 ? 'st-over' : 'st-under';
      marks += `<line class="st-gap ${cls}" x1="${bx.toFixed(1)}" x2="${bx.toFixed(1)}" y1="${Y(expected).toFixed(1)}" y2="${Y(row.book).toFixed(1)}"/>` +
        `<circle class="st-expected" cx="${bx.toFixed(1)}" cy="${Y(expected).toFixed(1)}" r="5"/>` +
        `<text class="st-note st-low" x="${(bx + 12).toFixed(1)}" y="${(Y(expected) + 4).toFixed(1)}">${expected}</text>`;
      aria += `, evidence supports ${expected}`;
    }
  }

  return (
    `<svg class="staircase" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">` +
    yAxis.join('') + axis.join('') +
    `<path class="st-line" d="${d}"/>` + dots.join('') + marks +
    `</svg>`
  );
}
