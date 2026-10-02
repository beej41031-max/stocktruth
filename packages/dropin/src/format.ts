export function money(n: number, symbol: string): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const body = abs >= 10 ? Math.round(abs).toLocaleString('en-GB') : abs.toFixed(abs % 1 === 0 ? 0 : 2);
  return `${sign}${symbol}${body}`;
}

export function units(n: number): string {
  return n.toLocaleString('en-GB');
}

export function signed(n: number): string {
  return n === 0 ? '0' : `${n > 0 ? '+' : '-'}${Math.abs(n).toLocaleString('en-GB')}`;
}

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  hourCycle: 'h23',
});

// shown in UTC and labelled, so a screenshot means the same thing on any machine
export function when(d: Date): string {
  return `${dateTime.format(d)} UTC`;
}

export function clock(d: Date): string {
  return d.toISOString().slice(11, 16);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}
