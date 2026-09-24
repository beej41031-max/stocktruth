#!/usr/bin/env node
/**
 * The engine, with nothing around it.
 *
 *   npx tsx packages/cli/src/index.ts examples/pallet.json
 *   cat evidence.json | npx tsx packages/cli/src/index.ts
 *   npx tsx packages/cli/src/index.ts examples/pallet.json --json
 *
 * This exists because the adapter and the Next.js app are proof that the
 * boundary can be reached from a real system. They are not proof it is easy
 * to reach from anywhere else. This is: one file, one dependency
 * (`@stocktruth/engine`), no Postgres, no Supabase, no server. Evidence in as
 * plain JSON, a conclusion out as plain JSON or as text a person can read.
 *
 * The shape it reads is `ReconciliationInput` with dates as ISO strings
 * instead of `Date` objects, because JSON has no date type. Everything else
 * is exactly what the engine itself consumes — this file does no reasoning
 * of its own, only the date conversion JSON cannot do for itself.
 */
import { readFileSync } from 'node:fs';
import { explain, DEFAULT_POLICY, MOVEMENT_SIGN, type MovementType, type ReconciliationInput } from '@stocktruth/engine';

interface JsonMovement {
  id: string;
  type: string;
  quantity: number;
  unit: string;
  occurredAt: string | null;
  recordedAt: string | null;
  importedAt: string;
  sourceSystemId: string | null;
  reversalOfId?: string | null;
}

interface EvidenceJson {
  item: ReconciliationInput['item'];
  locationId?: string | null;
  book?: {
    id: string;
    quantity: number;
    unit: string;
    asOf: string | null;
    sourceSystemId: string | null;
  } | null;
  count?: {
    id: string;
    quantity: number;
    unit: string;
    countedAt: string;
    receivedAt: string;
    countedBy: string | null;
    sessionId: string;
    sessionWatermark: string | null;
  } | null;
  movements?: JsonMovement[];
  unlinkedMovementCount?: number;
  possiblyRelatedUnlinkedCount?: number;
  sources?: ReconciliationInput['sources'];
  policy?: Partial<ReconciliationInput['policy']>;
  evaluatedAt?: string;
}

function optionalDate(s: string | null | undefined, label: string): Date | null {
  if (s == null) return null;
  return requiredDate(s, label);
}

function requiredDate(s: string, label: string): Date {
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not a valid date/time`);
  return parsed;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function movementType(value: string, label: string): MovementType {
  if (!(value in MOVEMENT_SIGN)) throw new Error(`${label} has unsupported movement type ${value}`);
  return value as MovementType;
}


/** The only real work this file does: strings become dates. */
function toInput(json: EvidenceJson): ReconciliationInput {
  return {
    item: json.item,
    locationId: json.locationId ?? null,
    book: json.book
      ? { id: json.book.id, quantity: finite(json.book.quantity, 'book.quantity'), unit: json.book.unit,
          asOf: optionalDate(json.book.asOf, 'book.asOf'), sourceSystemId: json.book.sourceSystemId }
      : null,
    count: json.count
      ? {
          id: json.count.id,
          quantity: finite(json.count.quantity, 'count.quantity'),
          unit: json.count.unit,
          countedAt: requiredDate(json.count.countedAt, 'count.countedAt'),
          receivedAt: requiredDate(json.count.receivedAt, 'count.receivedAt'),
          countedBy: json.count.countedBy,
          sessionId: json.count.sessionId,
          sessionWatermark: optionalDate(json.count.sessionWatermark, 'count.sessionWatermark'),
        }
      : null,
    movements: (json.movements ?? []).map((m, i) => ({
      id: m.id,
      type: movementType(m.type, `movements[${i}].type`),
      quantity: finite(m.quantity, `movements[${i}].quantity`),
      unit: m.unit,
      occurredAt: optionalDate(m.occurredAt, `movements[${i}].occurredAt`),
      recordedAt: optionalDate(m.recordedAt, `movements[${i}].recordedAt`),
      importedAt: requiredDate(m.importedAt, `movements[${i}].importedAt`),
      sourceSystemId: m.sourceSystemId,
      reversalOfId: m.reversalOfId,
    })),
    unlinkedMovementCount: json.unlinkedMovementCount ?? 0,
    possiblyRelatedUnlinkedCount: json.possiblyRelatedUnlinkedCount ?? 0,
    sources: json.sources ?? [],
    policy: { ...DEFAULT_POLICY, ...json.policy },
    evaluatedAt: json.evaluatedAt ? requiredDate(json.evaluatedAt, 'evaluatedAt') : new Date(),
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    if (process.stdin.isTTY) reject(new Error('no file given and no input piped in'));
  });
}

function printText(input: ReconciliationInput, e: ReturnType<typeof explain>): void {
  const label = input.item.sku ?? input.item.name;
  console.log(`\n${label}`);
  console.log(`state: ${e.state}`);
  console.log(`position: ${e.derivedQuantity != null ? e.derivedQuantity.toLocaleString() : 'CANNOT BE STATED'}\n`);

  if (e.blockers.length) {
    console.log('Blocked by:');
    for (const b of e.blockers) {
      console.log(`\n  ${b.code}`);
      console.log(`  ${wrap(b.resolution, 78, '  ')}`);
    }
    if (e.ifCleared?.quantity != null) {
      console.log(`\nIf cleared: ${e.ifCleared.quantity.toLocaleString()}`);
      for (const a of e.ifCleared.assuming) console.log(`  assuming: ${a}`);
    }
  } else {
    console.log('Nothing blocking.');
  }

  if (e.caveats.length) {
    console.log('\nCaveats:');
    for (const c of e.caveats) console.log(`  ${c.code}: ${c.short}`);
  }
  console.log();
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + indent);
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const file = args.find((a) => !a.startsWith('--'));

  const raw = file ? readFileSync(file, 'utf8') : await readStdin();
  const parsed = JSON.parse(raw) as EvidenceJson;
  const input = toInput(parsed);
  const result = explain(input);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(input, result);
  }

  process.exit(result.refused && !asJson ? 0 : 0);
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
