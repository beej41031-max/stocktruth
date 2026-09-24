import type {
  EvidenceSource,
  ReconciliationPolicy,
  ScopeEvidence,
  ScopeRef,
  SiteRef,
} from '../src/ports';

/**
 * An adapter made of arrays.
 *
 * This is the proof that the separation is real rather than cosmetic. If the
 * engine can be driven to every one of its states by this file, which contains
 * no database, no SQL, no schema and about eighty lines of nothing, then
 * nothing in the engine depends on where the data lives.
 *
 * It is also how a second host system would start: write one of these against
 * whatever their records look like, run the engine's own test suite against it,
 * and know the integration works before writing a line of application code.
 *
 * Knowledge time is implemented the same way a real adapter must implement it:
 * every record carries when this system learned it, and a query for a past
 * moment filters on that rather than on when the thing happened.
 */

interface Recorded<T> {
  /** When this host learned the record. Not when the thing happened. */
  knownAt: Date;
  value: T;
}

export class InMemoryEvidenceSource implements EvidenceSource {
  readonly supportsKnownAt = true;
  readonly adapterName = 'in-memory';

  private scopes = new Map<string, ScopeEvidence>();
  private books = new Map<string, Recorded<NonNullable<ScopeEvidence['book']>>[]>();
  private counts = new Map<string, Recorded<NonNullable<ScopeEvidence['count']>>[]>();
  private movements = new Map<string, Recorded<ScopeEvidence['movements'][number]>[]>();
  private policy: Partial<ReconciliationPolicy> = {};

  private key(scope: ScopeRef): string {
    return `${scope.itemId}::${scope.locationId ?? 'none'}`;
  }

  /** Register a scope with its item. Evidence is added separately. */
  addScope(scope: ScopeEvidence): this {
    this.scopes.set(this.key({ itemId: scope.item.id, locationId: scope.locationId }), scope);
    return this;
  }

  addBook(
    scope: ScopeRef,
    book: NonNullable<ScopeEvidence['book']>,
    knownAt: Date,
  ): this {
    const k = this.key(scope);
    this.books.set(k, [...(this.books.get(k) ?? []), { knownAt, value: book }]);
    return this;
  }

  addCount(
    scope: ScopeRef,
    count: NonNullable<ScopeEvidence['count']>,
    knownAt: Date,
  ): this {
    const k = this.key(scope);
    this.counts.set(k, [...(this.counts.get(k) ?? []), { knownAt, value: count }]);
    return this;
  }

  addMovement(
    scope: ScopeRef,
    movement: ScopeEvidence['movements'][number],
    knownAt: Date,
  ): this {
    const k = this.key(scope);
    this.movements.set(k, [...(this.movements.get(k) ?? []), { knownAt, value: movement }]);
    return this;
  }

  setPolicy(policy: Partial<ReconciliationPolicy>): this {
    this.policy = policy;
    return this;
  }

  async loadPolicy(): Promise<Partial<ReconciliationPolicy>> {
    return this.policy;
  }

  async listScopes(site: SiteRef, knownAt?: Date): Promise<ScopeRef[]> {
    return (await this.loadSite(site, knownAt)).map((s) => ({
      itemId: s.item.id,
      locationId: s.locationId,
    }));
  }

  async loadScope(site: SiteRef, scope: ScopeRef, knownAt?: Date): Promise<ScopeEvidence | null> {
    const base = this.scopes.get(this.key(scope));
    if (!base) return null;

    const visible = <T>(rows: Recorded<T>[] | undefined): T[] =>
      (rows ?? [])
        .filter((r) => !knownAt || r.knownAt.getTime() <= knownAt.getTime())
        .map((r) => r.value);

    const k = this.key(scope);

    // Newest book claim known by that moment. Undated claims lose to dated ones.
    const books = visible(this.books.get(k));
    const book =
      books.length === 0
        ? null
        : [...books].sort((a, b) => (b.asOf?.getTime() ?? -1) - (a.asOf?.getTime() ?? -1))[0]!;

    const counts = visible(this.counts.get(k));
    const count =
      counts.length === 0
        ? null
        : [...counts].sort((a, b) => b.countedAt.getTime() - a.countedAt.getTime())[0]!;

    return {
      ...base,
      book,
      count,
      movements: visible(this.movements.get(k)),
    };
  }

  async loadSite(site: SiteRef, knownAt?: Date): Promise<ScopeEvidence[]> {
    const out: ScopeEvidence[] = [];
    for (const base of this.scopes.values()) {
      const scope = await this.loadScope(
        site,
        { itemId: base.item.id, locationId: base.locationId },
        knownAt,
      );
      if (scope) out.push(scope);
    }
    return out;
  }
}
