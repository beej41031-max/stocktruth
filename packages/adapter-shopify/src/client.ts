/**
 * A read-only client for Shopify's GraphQL Admin API.
 *
 * Read-only is enforced here, not promised in a README: any document that
 * contains a mutation is refused before a byte leaves the machine. A merchant
 * handing over a token for an audit should be able to read this file and see
 * that nothing in the package can change their store.
 */

export const DEFAULT_API_VERSION = '2026-07';

/** The scopes the custom app needs. Nothing here writes. */
export const REQUIRED_SCOPES = [
  'read_products',
  'read_inventory',
  'read_locations',
  'read_orders',
  'read_inventory_transfers',
  'read_inventory_shipments',
  // Without this, Shopify silently returns only the last 60 days of orders.
  'read_all_orders',
] as const;

/**
 * Two ways in. Since January 2026 Shopify no longer lets merchants create
 * custom apps in the store admin, so a new app is made in the Dev Dashboard
 * and gives a client id and secret, exchanged here for a 24-hour token. The
 * exchange only works when the app and the store are in the same Shopify
 * organisation, so for an audit the merchant creates the app. A token from an
 * older admin-created app still works and can be passed directly.
 */
export type ShopifyCredentials =
  | { accessToken: string; clientId?: never; clientSecret?: never }
  | { clientId: string; clientSecret: string; accessToken?: never };

export type ShopifyClientOptions = ShopifyCredentials & {
  /** "northfold.myshopify.com" or just "northfold". */
  shop: string;
  apiVersion?: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Fixed in tests. */
  now?: () => number;
};

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: { currentlyAvailable: number; restoreRate: number };
    };
  };
}

export class ShopifyAdminClient {
  readonly shop: string;
  readonly apiVersion: string;
  private token: string | null;
  private tokenExpiresAt = Infinity;
  private readonly credentials: { clientId: string; clientSecret: string } | null;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(options: ShopifyClientOptions) {
    if (options.accessToken) {
      this.token = options.accessToken;
      this.credentials = null;
    } else if (options.clientId && options.clientSecret) {
      this.token = null;
      this.credentials = { clientId: options.clientId, clientSecret: options.clientSecret };
    } else {
      throw new ShopifyError('Give either an access token, or a client id and client secret', 'NO_TOKEN');
    }
    this.now = options.now ?? Date.now;
    const shop = options.shop.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!shop) throw new ShopifyError('No shop given', 'NO_SHOP');
    this.shop = shop.includes('.') ? shop : `${shop}.myshopify.com`;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 6;
  }

  get endpoint(): string {
    return `https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`;
  }

  /**
   * The client-credentials exchange. Tokens last 24 hours; a fresh one is
   * taken a minute before expiry so a long read never straddles the edge.
   */
  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.tokenExpiresAt - 60_000) return this.token;
    const creds = this.credentials!;
    const res = await this.fetchImpl(`https://${this.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      if (/shop_not_permitted/.test(text)) {
        throw new ShopifyError(
          'Shopify refused the client credentials for this shop (shop_not_permitted). The app and the store ' +
            "must be in the same Shopify organisation, so the app has to be created in the store owner's Dev Dashboard.",
          'AUTH',
        );
      }
      throw new ShopifyError(`Token request failed (${res.status}): ${text.slice(0, 200)}`, 'AUTH');
    }
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number; scope?: string };
    if (!body.access_token) throw new ShopifyError('Token response had no access_token', 'AUTH');
    const granted = new Set((body.scope ?? '').split(',').map((x) => x.trim()));
    // read_all_orders is left out of this check: Shopify answers without it,
    // just with 60 days of orders. fetchShopifySnapshot refuses longer
    // windows unless the caller confirms the scope was granted.
    const missing = REQUIRED_SCOPES.filter((sc) => sc !== 'read_all_orders' && !granted.has(sc));
    if (body.scope != null && missing.length) {
      throw new ShopifyError(
        `The app is missing scopes: ${missing.join(', ')}. Add them to the app's version in the Dev Dashboard ` +
          'and approve the change on the store.',
        'AUTH',
      );
    }
    this.token = body.access_token;
    this.tokenExpiresAt = this.now() + (body.expires_in ?? 86_399) * 1000;
    return this.token;
  }

  async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    assertReadOnly(document);

    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: document, variables }),
      });

      if (res.status === 401 || res.status === 403) {
        throw new ShopifyError(
          `Shopify refused the token (${res.status}). The custom app needs these Admin API scopes: ` +
            `${REQUIRED_SCOPES.join(', ')}. Check the token was copied in full and the app is installed.`,
          'AUTH',
        );
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new ShopifyError(`Shopify kept returning ${res.status} after ${attempt + 1} attempts`, 'UNAVAILABLE');
        }
        const retryAfter = Number(res.headers.get('Retry-After'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        await this.sleep(wait);
        continue;
      }

      if (!res.ok) {
        throw new ShopifyError(`Shopify returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, 'HTTP');
      }

      const body = (await res.json()) as GraphQLResponse<T>;
      const errors = body.errors ?? [];

      if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
        if (attempt >= this.maxRetries) {
          throw new ShopifyError(`Still throttled after ${attempt + 1} attempts`, 'THROTTLED');
        }
        await this.sleep(throttleWait(body) ?? backoff(attempt));
        continue;
      }

      if (errors.some((e) => e.extensions?.code === 'MAX_COST_EXCEEDED')) {
        // Not retryable as-is; the caller shrinks the page and asks again.
        throw new ShopifyError(errors.map((e) => e.message).join('; '), 'MAX_COST_EXCEEDED');
      }

      if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
        throw new ShopifyError(
          `Access denied: ${errors.map((e) => e.message).join('; ')}. Required scopes: ${REQUIRED_SCOPES.join(', ')}.`,
          'AUTH',
        );
      }

      if (errors.length > 0) {
        throw new ShopifyError(errors.map((e) => e.message).join('; '), 'GRAPHQL');
      }
      if (body.data == null) throw new ShopifyError('Shopify returned no data and no errors', 'EMPTY');
      return body.data;
    }
  }
}

/**
 * Refuses any document containing a mutation or subscription operation.
 * Deliberately blunt: strings and comments are stripped first, then any
 * occurrence of the keyword as an operation type is enough.
 */
export function assertReadOnly(document: string): void {
  const stripped = document
    .replace(/#[^\n]*/g, '')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/(^|[\s{}])(mutation|subscription)\b/i.test(stripped)) {
    throw new ShopifyError('This client is read-only and refuses to send a mutation.', 'READ_ONLY');
  }
}

function throttleWait(body: GraphQLResponse<unknown>): number | null {
  const cost = body.extensions?.cost;
  const status = cost?.throttleStatus;
  if (!status || !cost?.requestedQueryCost || status.restoreRate <= 0) return null;
  const deficit = cost.requestedQueryCost - status.currentlyAvailable;
  return Math.max(250, Math.ceil((deficit / status.restoreRate) * 1000) + 100);
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt);
}
