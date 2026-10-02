export interface Table {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

function guessDelimiter(firstLine: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

export function readTable(text: string): Table {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const delimiter = guessDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const kept = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const headers = (kept.shift() ?? []).map((h) => h.trim());
  return { headers, rows: kept, delimiter };
}

export function norm(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function findColumn(headers: string[], names: string[]): number {
  const wanted = names.map(norm);
  const cleaned = headers.map(norm);
  for (const w of wanted) {
    const i = cleaned.indexOf(w);
    if (i >= 0) return i;
  }
  return -1;
}
