'use server';

import { revalidatePath } from 'next/cache';
import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';

/**
 * Recording a count.
 *
 * Three things this has to get right, all of which came from watching real
 * stock systems get them wrong:
 *
 *   A retry must not write the count twice. The device generates an id and
 *   the database refuses the second one, so a bad signal in a cold store
 *   costs a spinner rather than 400 phantom cans.
 *
 *   A correction must not erase what it corrects. The old line stays and is
 *   marked superseded, so "why does it say 38" is answerable later.
 *
 *   A scan that resolves to two items must stop rather than pick. Guessing
 *   here puts real stock against the wrong code, and nobody finds out until
 *   the next count disagrees.
 */

export interface LookupResult {
  status: 'found' | 'ambiguous' | 'unknown' | 'blocked';
  message?: string;
  item?: {
    id: string;
    sku: string | null;
    name: string;
    stockUnit: string;
  };
  candidates?: { id: string; sku: string | null; name: string }[];
  /**
   * Withheld entirely under blind counting. Not blanked in the UI: never sent,
   * because a number in the page source is a number somebody can read.
   */
  book?: { quantity: string; asOf: string | null } | null;
  lastCount?: { quantity: string; countedAt: string; by: string | null } | null;
  /** True when figures were deliberately withheld, so the screen can say so. */
  blind?: boolean;
}

export async function lookupCode(siteId: string, raw: string): Promise<LookupResult> {
  const code = raw.trim();
  if (!code) return { status: 'unknown', message: 'Nothing scanned.' };

  const userId = await currentUserId();

  return withUser(userId, async (db) => {
    // Codes are matched with punctuation and case ignored, because a label,
    // an export and a person typing all disagree about those and mean the same
    // thing. Anything looser than this would start guessing.
    const matches = await db.query<{ id: string; sku: string | null; name: string; stock_unit: string; blocked: boolean; blocked_reason: string | null }>(
      `select distinct i.id, i.sku, i.name, i.stock_unit, i.blocked, i.blocked_reason
         from items i
         join sites s on s.organisation_id = i.organisation_id
         left join item_barcodes b on b.item_id = i.id and b.active
         left join item_aliases a on a.item_id = i.id
        where s.id = $1
          and i.active
          and (
            upper(regexp_replace(coalesce(i.sku,''), '[^A-Za-z0-9]', '', 'g')) = $2
            or upper(regexp_replace(coalesce(b.barcode,''), '[^A-Za-z0-9]', '', 'g')) = $2
            or upper(regexp_replace(coalesce(a.alias,''), '[^A-Za-z0-9]', '', 'g')) = $2
          )`,
      [siteId, code.toUpperCase().replace(/[^A-Za-z0-9]/g, '')],
    );

    if (matches.length === 0) {
      return { status: 'unknown', message: `${code} is not in the catalogue.` };
    }

    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        message: `${code} matches ${matches.length} items. Pick the right one.`,
        candidates: matches.map((m) => ({ id: m.id, sku: m.sku, name: m.name })),
      };
    }

    const item = matches[0]!;

    if (item.blocked) {
      return {
        status: 'blocked',
        message: item.blocked_reason ?? 'This code is blocked.',
        item: { id: item.id, sku: item.sku, name: item.name, stockUnit: item.stock_unit },
      };
    }

    const policy = await db.one<{ blind_count: boolean }>(
      `select blind_count from reconciliation_policies where site_id = $1`,
      [siteId],
    );
    // Default to blind when no policy row exists. Getting this wrong in the
    // cautious direction costs a counter nothing; getting it wrong the other
    // way silently devalues every count they take.
    const blind = policy?.blind_count ?? true;

    if (blind) {
      return {
        status: 'found',
        item: { id: item.id, sku: item.sku, name: item.name, stockUnit: item.stock_unit },
        blind: true,
      };
    }

    const book = await db.one<{ quantity: string; as_of: string | null }>(
      `select quantity::text, as_of from book_snapshots
        where site_id = $1 and item_id = $2
        order by as_of desc nulls last, created_at desc limit 1`,
      [siteId, item.id],
    );

    const last = await db.one<{ quantity: string; counted_at: string; email: string | null }>(
      `select cl.quantity::text, cl.counted_at, u.email
         from count_lines cl
         left join auth.users u on u.id = cl.counted_by
        where cl.site_id = $1 and cl.item_id = $2 and not cl.superseded
        order by cl.counted_at desc limit 1`,
      [siteId, item.id],
    );

    return {
      status: 'found',
      item: { id: item.id, sku: item.sku, name: item.name, stockUnit: item.stock_unit },
      book: book ? { quantity: book.quantity, asOf: book.as_of } : null,
      lastCount: last
        ? { quantity: last.quantity, countedAt: last.counted_at, by: last.email }
        : null,
    };
  });
}

export interface SaveCountInput {
  siteId: string;
  sessionId: string;
  itemId: string;
  locationId: string | null;
  quantity: number;
  unit: string;
  /** Generated on the device. The same value on a retry means the same count. */
  clientEventId: string;
  /** The device's clock, kept as sent so skew stays visible. */
  countedAt: string;
  note?: string;
  supersedesCountLineId?: string;
}

export interface SaveCountResult {
  status: 'saved' | 'already_saved' | 'refused';
  message: string;
  countLineId?: string;
}

export async function saveCount(payload: SaveCountInput): Promise<SaveCountResult> {
  const userId = await currentUserId();

  if (!Number.isFinite(payload.quantity) || payload.quantity < 0) {
    return { status: 'refused', message: 'A count cannot be negative or blank.' };
  }

  return withUser(userId, async (db) => {
    // A resend of the same physical count. Report it honestly rather than
    // writing a second row or pretending the first never happened.
    const existing = await db.one<{ id: string }>(
      `select id from count_lines where client_event_id = $1`,
      [payload.clientEventId],
    );
    if (existing) {
      return {
        status: 'already_saved',
        message: 'This count was already recorded. Nothing written twice.',
        countLineId: existing.id,
      };
    }

    const site = await db.one<{ organisation_id: string }>(
      `select organisation_id from sites where id = $1`,
      [payload.siteId],
    );
    if (!site) return { status: 'refused', message: 'Site not found.' };

    if (payload.supersedesCountLineId) {
      await db.query(`update count_lines set superseded = true where id = $1`, [
        payload.supersedesCountLineId,
      ]);
    }

    const row = await db.one<{ id: string }>(
      `insert into count_lines
         (count_session_id, organisation_id, site_id, item_id, location_id,
          quantity, unit, counted_by, counted_at, method, note,
          client_event_id, supersedes_count_line_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scan',$10,$11,$12)
       returning id`,
      [
        payload.sessionId,
        site.organisation_id,
        payload.siteId,
        payload.itemId,
        payload.locationId,
        payload.quantity,
        payload.unit,
        userId,
        payload.countedAt,
        payload.note ?? null,
        payload.clientEventId,
        payload.supersedesCountLineId ?? null,
      ],
    );

    revalidatePath('/count');
    revalidatePath(`/items/${payload.itemId}`);

    return {
      status: 'saved',
      message: payload.supersedesCountLineId
        ? 'Saved. The earlier count is kept in the history.'
        : 'Saved.',
      countLineId: row!.id,
    };
  });
}

export async function startSession(siteId: string, name: string): Promise<string> {
  const userId = await currentUserId();
  return withUser(userId, async (db) => {
    const site = await db.one<{ organisation_id: string }>(
      `select organisation_id from sites where id = $1`,
      [siteId],
    );
    if (!site) throw new Error('Site not found');

    // The watermark is how far the movement feed had got when counting began.
    // Anything that arrives after this but happened before a count is exactly
    // the case the engine refuses to guess at, and it needs this to spot it.
    const row = await db.one<{ id: string }>(
      `insert into count_sessions
         (organisation_id, site_id, name, status, started_by, started_at, source_watermark)
       values ($1,$2,$3,'open',$4, now(),
               coalesce((select max(imported_at) from movements where site_id = $2), now()))
       returning id`,
      [site.organisation_id, siteId, name, userId],
    );
    revalidatePath('/count');
    return row!.id;
  });
}

export interface RevealResult {
  book: { quantity: string; asOf: string | null } | null;
  lastCount: { quantity: string; countedAt: string } | null;
  difference: number | null;
}

/**
 * What the records said, fetched only after a count has been written.
 *
 * Safe to show now: the observation is already in the database and cannot be
 * changed by the counter seeing this. It deliberately reports a difference
 * rather than a discrepancy. Nobody at the rack knows yet whether a gap is
 * shrinkage, a late delivery or a bad book figure, and the reconciliation
 * cannot answer that until it has the movements in front of it.
 */
export async function revealAfterCount(
  siteId: string,
  itemId: string,
  countedQuantity: number,
): Promise<RevealResult> {
  const userId = await currentUserId();

  return withUser(userId, async (db) => {
    const policy = await db.one<{ reveal_after_count: boolean }>(
      `select reveal_after_count from reconciliation_policies where site_id = $1`,
      [siteId],
    );
    if (policy && !policy.reveal_after_count) {
      return { book: null, lastCount: null, difference: null };
    }

    const book = await db.one<{ quantity: string; as_of: string | null }>(
      `select quantity::text, as_of from book_snapshots
        where site_id = $1 and item_id = $2
        order by as_of desc nulls last, created_at desc limit 1`,
      [siteId, itemId],
    );

    const prev = await db.one<{ quantity: string; counted_at: string }>(
      `select quantity::text, counted_at from count_lines
        where site_id = $1 and item_id = $2 and not superseded
          and quantity is not null
        order by counted_at desc offset 1 limit 1`,
      [siteId, itemId],
    );

    return {
      book: book ? { quantity: book.quantity, asOf: book.as_of } : null,
      lastCount: prev ? { quantity: prev.quantity, countedAt: prev.counted_at } : null,
      difference: book ? countedQuantity - Number(book.quantity) : null,
    };
  });
}

export interface ResolveInput {
  issueId: string;
  resolution: 'accepted' | 'recount' | 'investigating' | 'data_fixed' | 'not_an_issue';
  note: string;
}

/**
 * Closing an issue.
 *
 * A note is required, and the database enforces it too, because the form is
 * not the only way rows get written. "Resolved" with no reason is how an audit
 * trail turns back into a list of timestamps.
 */
export async function resolveIssue(input: ResolveInput): Promise<{ ok: boolean; message: string }> {
  const userId = await currentUserId();
  const note = input.note.trim();

  if (!note) {
    return { ok: false, message: 'Say what you did and why. This gets read months from now.' };
  }

  return withUser(userId, async (db) => {
    const issue = await db.one<{ id: string; organisation_id: string; site_id: string; item_id: string | null }>(
      `select id, organisation_id, site_id, item_id from reconciliation_issues where id = $1`,
      [input.issueId],
    );
    if (!issue) return { ok: false, message: 'Issue not found.' };

    // Asking for a recount keeps the issue open. The work is not done because
    // somebody decided it needs doing.
    const keepOpen = input.resolution === 'recount' || input.resolution === 'investigating';

    await db.query(
      `update reconciliation_issues
          set status = $2, resolution = $3, resolution_note = $4,
              resolved_by = $5, resolved_at = case when $2 = 'resolved' then now() else null end,
              recount_requested = $6
        where id = $1`,
      [
        input.issueId,
        keepOpen ? 'open' : 'resolved',
        input.resolution,
        note,
        userId,
        input.resolution === 'recount',
      ],
    );

    await db.query(
      `insert into audit_events
         (organisation_id, site_id, actor_user_id, actor_type, event_type, object_type, object_id, detail)
       values ($1,$2,$3,'user','ISSUE_RESOLUTION_SET','reconciliation_issue',$4,$5)`,
      [
        issue.organisation_id,
        issue.site_id,
        userId,
        input.issueId,
        JSON.stringify({ resolution: input.resolution, note }),
      ],
    );

    revalidatePath('/reconcile');
    if (issue.item_id) revalidatePath(`/items/${issue.item_id}`);

    return {
      ok: true,
      message: keepOpen ? 'Recorded. Left open until it is actually done.' : 'Recorded.',
    };
  });
}
