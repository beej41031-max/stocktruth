import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShopifyAdminClient, ShopifyError, assertReadOnly, fetchShopifySnapshot } from '../src/index';

/**
 * The network layer, against a scripted fake of Shopify. No store, no token.
 */

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeShopify(replies: Reply[] | ((body: { query: string; variables: Record<string, unknown> }) => Reply)) {
  const calls: { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const reply = typeof replies === 'function' ? replies(body) : replies.shift();
    if (!reply) throw new Error('fake Shopify ran out of replies');
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as unknown as typeof fetch;
  const client = new ShopifyAdminClient({
    shop: 'northfold',
    accessToken: 'shpat_test',
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { client, calls, waits };
}

test('read-only is enforced before anything is sent', async () => {
  const { client, calls } = fakeShopify([]);
  await assert.rejects(
    client.query('mutation { inventoryAdjustQuantities(input: {}) { userErrors { message } } }'),
    (e: ShopifyError) => e.code === 'READ_ONLY',
  );
  await assert.rejects(client.query('  # harmless comment\n mutation M { x }'), /read-only/);
  assert.equal(calls.length, 0, 'nothing reached the network');
});

test('the read-only check is not fooled by strings or comments, and does not flag field names', () => {
  assert.doesNotThrow(() => assertReadOnly('query { shop { name } } # no mutation here'));
  assert.doesNotThrow(() => assertReadOnly('query($q: String = "mutation {}") { orders(query: $q) { nodes { id } } }'));
  assert.doesNotThrow(() => assertReadOnly('query { subscriptionContracts(first: 1) { nodes { id } } }'));
  assert.throws(() => assertReadOnly('subscription { orderCreated { id } }'), /read-only/);
});

test('the request goes to the pinned API version with the token header', async () => {
  const { client, calls } = fakeShopify([{ body: { data: { shop: { name: 'x' } } } }]);
  await client.query('query { shop { name } }');
  assert.equal(calls[0]!.url, 'https://northfold.myshopify.com/admin/api/2026-07/graphql.json');
  assert.equal(calls[0]!.headers['X-Shopify-Access-Token'], 'shpat_test');
});

test('a throttled query waits for the bucket to refill, then retries', async () => {
  const { client, calls, waits } = fakeShopify([
    {
      body: {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } } },
      },
    },
    { body: { data: { ok: true } } },
  ]);
  assert.deepEqual(await client.query('query { ok }'), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(waits[0], 4100, '400 points short at 100 per second, plus a margin');
});

test('429 honours Retry-After; 5xx backs off; both give up eventually', async () => {
  const { client, waits } = fakeShopify([
    { status: 429, headers: { 'Retry-After': '2' } },
    { status: 503 },
    { body: { data: { ok: 1 } } },
  ]);
  await client.query('query { ok }');
  assert.deepEqual(waits, [2000, 1000]);

  const dead = fakeShopify(() => ({ status: 502 }));
  await assert.rejects(dead.client.query('query { ok }'), (e: ShopifyError) => e.code === 'UNAVAILABLE');
});

test('a rejected token names the scopes to grant', async () => {
  const { client } = fakeShopify([{ status: 401 }]);
  await assert.rejects(client.query('query { ok }'), /read_inventory.*read_all_orders/);
});

test('GraphQL errors are raised, never swallowed into empty data', async () => {
  const { client } = fakeShopify([{ body: { errors: [{ message: "Field 'nope' doesn't exist" }] } }]);
  await assert.rejects(client.query('query { nope }'), /doesn't exist/);
});

test('a page too expensive for Shopify is retried at half the size', async () => {
  const sizes: number[] = [];
  const { client } = fakeShopify((body) => {
    const first = body.variables.first as number;
    const root = /locations\(/.test(body.query) ? 'locations' : /productVariants\(/.test(body.query) ? 'productVariants' : /inventoryTransfers\(/.test(body.query) ? 'inventoryTransfers' : 'orders';
    if (root === 'productVariants') sizes.push(first);
    if (root === 'productVariants' && first > 6) {
      return { body: { errors: [{ message: 'Query cost is too high', extensions: { code: 'MAX_COST_EXCEEDED' } }] } };
    }
    return { body: { data: { [root]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
  });
  await fetchShopifySnapshot(client, { ordersSince: new Date('2026-09-21T00:00:00Z') });
  assert.deepEqual(sizes, [25, 12, 6]);
});

test('pagination follows cursors and the snapshot keeps the order window', async () => {
  const pages: Record<string, Reply[]> = {
    locations: [
      { body: { data: { locations: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ id: 'L1', name: 'A', isActive: true }] } } } },
      { body: { data: { locations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'L2', name: 'B', isActive: false }] } } } },
    ],
  };
  const seen: { cursor: unknown; query?: unknown }[] = [];
  const { client } = fakeShopify((body) => {
    const root = /locations\(/.test(body.query) ? 'locations' : /productVariants\(/.test(body.query) ? 'productVariants' : /inventoryTransfers\(/.test(body.query) ? 'inventoryTransfers' : 'orders';
    seen.push({ cursor: body.variables.cursor, query: body.variables.query });
    const scripted = pages[root]?.shift();
    return scripted ?? { body: { data: { [root]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
  });
  const snap = await fetchShopifySnapshot(client, {
    ordersSince: new Date('2026-09-21T00:00:00Z'),
    now: () => new Date('2026-09-22T18:00:00Z'),
  });
  assert.deepEqual(snap.locations.map((l) => l.id), ['L1', 'L2']);
  assert.equal(seen[1]!.cursor, 'c1');
  assert.ok(seen.some((x) => x.query === "updated_at:>='2026-09-21T00:00:00.000Z'"), 'orders filtered by window');
  assert.equal(snap.fetchedAt, '2026-09-22T18:00:00.000Z');
  assert.equal(snap.ordersSince, '2026-09-21T00:00:00.000Z');
});

test('a variant response maps on_hand, available and committed, and refuses a missing quantity', async () => {
  const variant = (quantities: { name: string; quantity: number }[]) => ({
    id: 'V1', sku: ' TEE-1 ', title: 'Black / M',
    product: { title: 'Tee', status: 'ACTIVE' },
    inventoryItem: {
      id: 'I1', tracked: true,
      inventoryLevels: { pageInfo: { hasNextPage: false }, nodes: [{ updatedAt: '2026-09-22T17:00:00Z', location: { id: 'L1' }, quantities }] },
    },
  });
  const make = (q: { name: string; quantity: number }[]) =>
    fakeShopify((body) => {
      const root = /locations\(/.test(body.query) ? 'locations' : /productVariants\(/.test(body.query) ? 'productVariants' : /inventoryTransfers\(/.test(body.query) ? 'inventoryTransfers' : 'orders';
      const nodes = root === 'productVariants' ? [variant(q)] : [];
      return { body: { data: { [root]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
    }).client;

  const snap = await fetchShopifySnapshot(
    make([
      { name: 'on_hand', quantity: 10 },
      { name: 'available', quantity: 6 },
      { name: 'committed', quantity: 3 },
      { name: 'damaged', quantity: 1 },
      { name: 'quality_control', quantity: 0 },
    ]),
    { ordersSince: new Date('2026-09-21T00:00:00Z') },
  );
  assert.equal(snap.variants[0]!.sku, 'TEE-1', 'whitespace trimmed');
  assert.deepEqual(
    { ...snap.variants[0]!.levels[0]!, updatedAt: undefined },
    { locationId: 'L1', onHand: 10, available: 6, committed: 3, damaged: 1, qualityControl: 0, updatedAt: undefined },
  );

  await assert.rejects(
    fetchShopifySnapshot(make([{ name: 'available', quantity: 7 }]), { ordersSince: new Date('2026-09-21T00:00:00Z') }),
    /no "on_hand" quantity/,
  );
});

test('an order with more refund lines than one page is refused rather than truncated', async () => {
  const order = {
    id: 'O1', name: '#1', createdAt: '2026-09-22T10:00:00Z', fulfillments: [],
    refunds: [{ id: 'R1', createdAt: '2026-09-22T11:00:00Z', refundLineItems: { pageInfo: { hasNextPage: true }, nodes: [] } }],
  };
  const { client } = fakeShopify((body) => {
    const root = /locations\(/.test(body.query) ? 'locations' : /productVariants\(/.test(body.query) ? 'productVariants' : /inventoryTransfers\(/.test(body.query) ? 'inventoryTransfers' : 'orders';
    const nodes = root === 'orders' ? [order] : [];
    return { body: { data: { [root]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
  });
  await assert.rejects(
    fetchShopifySnapshot(client, { ordersSince: new Date('2026-09-21T00:00:00Z') }),
    (e: ShopifyError) => e.code === 'OVERFLOW',
  );
});

// --- Dev Dashboard client credentials ----------------------------------------

function credentialShopify(tokenReplies: Reply[], clock: { t: number }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/admin/oauth/access_token')) {
      const form = new URLSearchParams(String(init.body));
      calls.push(`token:${form.get('grant_type')}:${form.get('client_id')}`);
      const r = tokenReplies.shift()!;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    calls.push(`graphql:${(init.headers as Record<string, string>)['X-Shopify-Access-Token']}`);
    return new Response(JSON.stringify({ data: { ok: true } }));
  }) as unknown as typeof fetch;
  const client = new ShopifyAdminClient({
    shop: 'northfold',
    clientId: 'cid',
    clientSecret: 'secret',
    fetchImpl,
    sleep: async () => {},
    now: () => clock.t,
  });
  return { client, calls };
}

const SCOPES =
  'read_products,read_inventory,read_locations,read_orders,read_inventory_transfers,read_inventory_shipments';

test('client credentials are exchanged once, reused, and refreshed before the 24 hours run out', async () => {
  const clock = { t: 0 };
  const { client, calls } = credentialShopify(
    [
      { body: { access_token: 'tok1', expires_in: 86399, scope: SCOPES } },
      { body: { access_token: 'tok2', expires_in: 86399, scope: SCOPES } },
    ],
    clock,
  );
  await client.query('query { ok }');
  await client.query('query { ok }');
  clock.t = 86_399_000 - 30_000; // inside the last minute
  await client.query('query { ok }');
  assert.deepEqual(calls, [
    'token:client_credentials:cid',
    'graphql:tok1',
    'graphql:tok1',
    'token:client_credentials:cid',
    'graphql:tok2',
  ]);
});

test('credentials for a store in another organisation get an explanation, not a bare 400', async () => {
  const { client } = credentialShopify(
    [{ status: 400, body: 'Oauth error shop_not_permitted: Client credentials cannot be performed on this shop.' }],
    { t: 0 },
  );
  await assert.rejects(client.query('query { ok }'), /same Shopify organisation/);
});

test('an app missing a read scope is refused at the token, naming the scope', async () => {
  const { client } = credentialShopify(
    [{ body: { access_token: 't', expires_in: 86399, scope: 'read_products,read_orders' } }],
    { t: 0 },
  );
  await assert.rejects(client.query('query { ok }'), /missing scopes: read_inventory, read_locations/);
});

test('an order window Shopify would silently cut to 60 days is refused unless the scope is confirmed', async () => {
  const { client } = fakeShopify(() => ({
    body: { data: { locations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
  }));
  const now = () => new Date('2026-09-22T18:00:00Z');
  await assert.rejects(
    fetchShopifySnapshot(client, { ordersSince: new Date('2026-06-01T00:00:00Z'), now }),
    (e: ShopifyError) => e.code === 'WINDOW' && /read_all_orders/.test(e.message),
  );
});

test('no credentials at all is refused at construction', () => {
  assert.throws(
    () => new ShopifyAdminClient({ shop: 'x' } as never),
    /access token, or a client id and client secret/,
  );
});

test('location discovery includes fulfilment-service locations', async () => {
  const seen: string[] = [];
  const { client } = fakeShopify((body) => {
    seen.push(body.query);
    const root = /locations\(/.test(body.query) ? 'locations' : /productVariants\(/.test(body.query) ? 'productVariants' : /inventoryTransfers\(/.test(body.query) ? 'inventoryTransfers' : 'orders';
    return { body: { data: { [root]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
  });
  await fetchShopifySnapshot(client, { ordersSince: new Date(Date.now() - 86_400_000) });
  assert.match(seen.find((q) => /locations\(/.test(q))!, /includeLegacy: true/);
});

test('a transfer response maps origin, destination, dates and accepted/rejected units', async () => {
  const transfer = {
    id: 'T1', name: '#T1', status: 'PARTIALLY_RECEIVED',
    origin: { location: { id: 'L1' } }, destination: { location: { id: 'L2' } },
    shipments: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'S1', status: 'PARTIALLY_RECEIVED', dateCreated: '2026-09-22T09:00:00Z',
      dateShipped: '2026-09-22T10:00:00Z', dateReceived: '2026-09-22T12:00:00Z',
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [
        { quantity: 5, acceptedQuantity: 3, rejectedQuantity: 0, unreceivedQuantity: 2, inventoryItem: { id: 'I1', sku: 'A' } },
      ] },
    }] },
  };
  const { client } = fakeShopify((body) => {
    const root = /locations\(/.test(body.query) ? 'locations' : /productVariants\(/.test(body.query) ? 'productVariants' : /inventoryTransfers\(/.test(body.query) ? 'inventoryTransfers' : 'orders';
    const nodes = root === 'inventoryTransfers' ? [transfer] : [];
    return { body: { data: { [root]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
  });
  const snap = await fetchShopifySnapshot(client, { ordersSince: new Date(Date.now() - 86_400_000) });
  const t = snap.transfers![0]!;
  assert.equal(t.originLocationId, 'L1');
  assert.equal(t.destinationLocationId, 'L2');
  assert.deepEqual(t.shipments[0]!.lines[0], { inventoryItemId: 'I1', sku: 'A', quantity: 5, accepted: 3, rejected: 0, unreceived: 2 });
});
