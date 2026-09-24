import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * Generates a large, deliberately unpleasant warehouse.
 *
 * The 53 hand-written engine tests each isolate one defect. This does the
 * opposite: it throws every defect class at once, in whatever combination a
 * seeded random walk produces, at a scale no reviewer is going to hand-check.
 * If the invariant holds here, it holds because the rule is right, not
 * because the test cases were chosen kindly.
 *
 * Deterministic. The same seed produces the same warehouse, so a later engine
 * version gets exactly the same bad day and any change in outcome is a real
 * change in behaviour, not noise.
 */

// A tiny, dependency-free PRNG. Good enough for generating awkward data,
// nowhere near good enough for anything that needed to be unpredictable.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenerateOptions {
  organisationId: string;
  siteId: string;
  itemCount: number;
  movementsPerItem: number;
  seed?: number;
}

export interface GenerateResult {
  itemCount: number;
  bookSnapshots: number;
  countLines: number;
  movements: number;
  evidenceRows: number;
}

const NOW = new Date('2026-09-18T09:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const hour = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

export async function generateStressData(
  pool: Pool,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const rand = mulberry32(opts.seed ?? 20260918);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const chance = (p: number) => rand() < p;

  const client = await pool.connect();
  let bookSnapshots = 0;
  let countLines = 0;
  let movements = 0;

  try {
    await client.query('begin');

    await client.query(
      `insert into organisations (id, name) values ($1, 'Stress Test Co.') on conflict (id) do nothing`,
      [opts.organisationId],
    );
    await client.query(
      `insert into sites (id, organisation_id, name) values ($1, $2, 'Stress site')
       on conflict (id) do nothing`,
      [opts.siteId, opts.organisationId],
    );
    await client.query(
      `insert into locations (id, site_id, code) values ($1, $2, 'L-1')
       on conflict (site_id, code) do nothing`,
      [randomUUID(), opts.siteId],
    );
    const locRow = await client.query<{ id: string }>(
      `select id from locations where site_id = $1 limit 1`,
      [opts.siteId],
    );
    const locationId = locRow.rows[0]!.id;

    const units = ['each', 'kg', 'box', 'case'];
    const itemIds: string[] = [];

    for (let i = 0; i < opts.itemCount; i++) {
      const id = randomUUID();
      itemIds.push(id);

      // A slice of items are deliberately broken identities, because those are
      // the cases the engine has to refuse fastest and most cheaply.
      const blocked = chance(0.01);
      const unit = pick(units);

      await client.query(
        `insert into items (id, organisation_id, sku, name, stock_unit, active, blocked, blocked_reason)
         values ($1,$2,$3,$4,$5,true,$6,$7)`,
        [
          id,
          opts.organisationId,
          `STRESS-${String(i).padStart(6, '0')}`,
          `Stress item ${i}`,
          unit,
          blocked,
          blocked ? 'synthetic: code covers two things' : null,
        ],
      );

      // ~1% of items share a barcode with another item on purpose. The
      // ambiguity is meant to be there.
      if (chance(0.01) && itemIds.length > 1) {
        const twin = pick(itemIds.slice(0, -1));
        const sharedBarcode = `SHARED-${Math.floor(i / 50)}`;
        await client.query(
          `insert into item_barcodes (item_id, barcode) values ($1,$2),($3,$2)`,
          [id, sharedBarcode, twin],
        );
      }

      // Book position: usually present, sometimes undated, sometimes absent.
      if (chance(0.85)) {
        const asOf = chance(0.1) ? null : day(10 + Math.floor(rand() * 60));
        await client.query(
          `insert into book_snapshots (organisation_id, site_id, item_id, quantity, unit, as_of, created_at)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            opts.organisationId,
            opts.siteId,
            id,
            Math.floor(rand() * 5000),
            chance(0.02) ? pick(units.filter((u) => u !== unit)) : unit, // occasional unit mismatch
            asOf,
            day(9 + Math.floor(rand() * 60)),
          ],
        );
        bookSnapshots++;
      }

      // Count: most items counted, a slice never counted, a slice counted long ago.
      let countedAt: Date | null = null;
      if (chance(0.9)) {
        const session = await client.query<{ id: string }>(
          `insert into count_sessions (organisation_id, site_id, status, started_at, completed_at, source_watermark)
           values ($1,$2,'completed',now(),now(),now()) returning id`,
          [opts.organisationId, opts.siteId],
        );
        countedAt = chance(0.15) ? day(45 + Math.floor(rand() * 90)) : hour(1 + Math.floor(rand() * 60));
        const qty = Math.floor(rand() * 5000);
        await client.query(
          `insert into count_lines
             (count_session_id, organisation_id, site_id, item_id, location_id, quantity, unit, counted_at, received_at, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`,
          [
            session.rows[0]!.id,
            opts.organisationId,
            opts.siteId,
            id,
            chance(0.05) ? null : locationId, // some counted with no location
            qty,
            chance(0.015) ? pick(units.filter((u) => u !== unit)) : unit,
            countedAt,
            countedAt,
          ],
        );
        countLines++;
      }

      // Movements: the adversarial heart of the generator.
      for (let m = 0; m < opts.movementsPerItem; m++) {
        if (!chance(0.7)) continue; // not every item gets every movement slot

        const baseOffset = Math.floor(rand() * 90);
        let occurredAt: Date | null = day(baseOffset) as Date | null;
        let recordedAt: Date | null = occurredAt;

        const roll = rand();
        if (roll < 0.04) {
          occurredAt = null; // undated
          recordedAt = null;
        } else if (roll < 0.1 && countedAt) {
          // The canonical defect: happened before the count, recorded after it.
          occurredAt = new Date(countedAt.getTime() - (10 + rand() * 300) * 60_000);
          recordedAt = new Date(countedAt.getTime() + (30 + rand() * 300) * 60_000);
        } else if (roll < 0.14) {
          // Recorded well after it happened, but not spanning a count. Just late.
          recordedAt = new Date(occurredAt!.getTime() + (60 + rand() * 600) * 60_000);
        }

        const type = pick(['RECEIVE', 'ISSUE', 'TRANSFER_IN', 'TRANSFER_OUT', 'WASTE', 'RETURN'] as const);
        const qty = Math.floor(rand() * 300) + 1;

        await client.query(
          `insert into movements
             (organisation_id, site_id, item_id, location_id, movement_type, quantity, unit,
              occurred_at, recorded_at, imported_at, source_system_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null)`,
          [
            opts.organisationId,
            opts.siteId,
            id,
            locationId,
            type,
            qty,
            chance(0.01) ? pick(units.filter((u) => u !== unit)) : unit,
            occurredAt,
            recordedAt,
            recordedAt ?? day(baseOffset),
          ],
        );
        movements++;

        // Occasionally duplicate the row that was just written, close in time.
        if (chance(0.02) && occurredAt) {
          await client.query(
            `insert into movements
               (organisation_id, site_id, item_id, location_id, movement_type, quantity, unit,
                occurred_at, recorded_at, imported_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`,
            [
              opts.organisationId,
              opts.siteId,
              id,
              locationId,
              type,
              qty,
              unit,
              new Date(occurredAt.getTime() + 90_000),
              new Date(occurredAt.getTime() + 90_000),
            ],
          );
          movements++;
        }
      }
    }

    // A block of movements the generator deliberately fails to attach to any
    // item, some of which carry a code close enough to a real one to matter.
    const orphanCount = Math.max(5, Math.floor(opts.itemCount * 0.02));
    for (let i = 0; i < orphanCount; i++) {
      const nearMiss = chance(0.3) ? pick(itemIds) : null;
      const code = nearMiss
        ? `STRESS-${nearMiss.slice(-6)}` // will not actually match a real sku format, deliberately imperfect
        : `UNKNOWN-${randomUUID().slice(0, 8)}`;
      await client.query(
        `insert into movements
           (organisation_id, site_id, item_id, location_id, movement_type, quantity, unit,
            occurred_at, recorded_at, imported_at, raw_payload)
         values ($1,$2,null,null,'RECEIVE',$3,'each',$4,$4,$4,$5)`,
        [
          opts.organisationId,
          opts.siteId,
          Math.floor(rand() * 100) + 1,
          day(Math.floor(rand() * 90)),
          JSON.stringify({ code }),
        ],
      );
      movements++;
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  return {
    itemCount: opts.itemCount,
    bookSnapshots,
    countLines,
    movements,
    evidenceRows: bookSnapshots + countLines + movements,
  };
}

export async function cleanupStressData(pool: Pool, organisationId: string): Promise<void> {
  await pool.query(`delete from organisations where id = $1`, [organisationId]);
}
