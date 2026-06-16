/**
 * Wire helpers — the entire YieldFabric HTTP surface this app touches
 * beyond what the wallet-SDK already owns.
 *
 * The routing rule, straight from the docs
 * (https://yieldfabric.com/docs/guides/building-with-yf):
 *
 *   DEAL-FLOW + READS  → federated gateway   api.yieldfabric.com/graphql   gatewayQuery / gatewayMutation
 *   ON-CHAIN MUTATIONS → payments-direct     pay.yieldfabric.com/graphql   paymentsMutation
 *   SETTLEMENT         → REST status polling  pay.yieldfabric.com/api/...    waitForMessage
 *
 * The DMS deal lifecycle (saveDealDraft / proposeDraft / signDeal /
 * activateDeal) and the cross-service reads (rent-schedule contracts,
 * entity directory, asset catalog) ride the federation gateway — the
 * same composed `dealFlow { … }` namespace the first-party app uses.
 * The money loop (collect / exchange / settle) submits on-chain work,
 * so it takes the payments-direct route.
 *
 * Mutations that submit on-chain work return as soon as the message
 * queue enqueues them — `success: true` means "accepted", not "done".
 * To know an operation actually settled on chain, poll the message
 * status endpoint until `executed` is set. That polling loop is
 * `waitForMessage` below; it is the same pattern the YF Python SDK's
 * `poll_message_completion` and the first-party app use.
 *
 * Auth: the wallet-SDK owns the session. We read the current access
 * token from its `tokenManager` — never store tokens yourself. Calls
 * that act AS a property group pass an explicit group-delegation JWT
 * (see `lib/delegation.ts`) as the optional `token` argument.
 */
import { tokenManager } from '@yieldfabric/wallet/core/tokenManager';
import { GATEWAY_GRAPHQL_URL, PAYMENTS_URL } from '../config';

interface GraphQLErrorShape {
  message: string;
  extensions?: { code?: string };
}

async function graphqlPost<T>(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
  token?: string | null
): Promise<T> {
  const bearer = token ?? tokenManager.getCurrentToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  // GraphQL is HTTP 200 even on errors — switch on the `errors` array,
  // not the status code.
  const body = (await res.json()) as { data?: T; errors?: GraphQLErrorShape[] };
  if (body.errors && body.errors.length > 0) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  if (!body.data) {
    throw new Error(`GraphQL response missing data (HTTP ${res.status})`);
  }
  return body.data;
}

/** Cross-service QUERIES + the DMS deal-flow namespace ride the
 *  federated gateway. */
export function gatewayQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string | null
): Promise<T> {
  return graphqlPost<T>(GATEWAY_GRAPHQL_URL, query, variables, token);
}

/** DMS lifecycle mutations (saveDealDraft / proposeDraft / signDeal /
 *  activateDeal / setDealAutomationKey …) also ride the gateway — they
 *  live on the agents subgraph, not the on-chain payments path. Same
 *  impl as `gatewayQuery`; named for intent. */
export function gatewayMutation<T>(
  mutation: string,
  variables?: Record<string, unknown>,
  token?: string | null
): Promise<T> {
  return graphqlPost<T>(GATEWAY_GRAPHQL_URL, mutation, variables, token);
}

/** ON-CHAIN MUTATIONS (collect / exchange / settle) go payments-direct
 *  — the same route the first-party app's `executeGraphQLMutation`
 *  takes. Pass `token` to submit acting AS a property group. */
export function paymentsMutation<T>(
  mutation: string,
  variables?: Record<string, unknown>,
  token?: string | null
): Promise<T> {
  return graphqlPost<T>(`${PAYMENTS_URL}/graphql`, mutation, variables, token);
}

/** Caller-scoped READS that must resolve under a specific identity go
 *  payments-direct too — e.g. `paymentsByEntity` / `walletFlow.activity`
 *  for a property GROUP, which are computed for whoever the bearer is, so
 *  they're sent with the group-delegation `token` (not the user's). */
export function paymentsQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string | null
): Promise<T> {
  return graphqlPost<T>(`${PAYMENTS_URL}/graphql`, query, variables, token);
}

// ── REST: balance + message-status polling ───────────────────────────

/** A confidential-balance read off the vault. `obligor` omitted ⇒ liquid
 *  CASH the account holds; `obligor` set ⇒ CREDIT held against that
 *  obligor (claimed-but-unsettled rent). Acting AS the property group
 *  needs the group-delegation `token`. */
export async function fetchBalance(
  denomination: string,
  opts: { obligor?: string; token?: string | null } = {}
): Promise<{ raw: string; decimals: string }> {
  const bearer = opts.token ?? tokenManager.getCurrentToken();
  const params = new URLSearchParams({ denomination });
  if (opts.obligor) params.set('obligor', opts.obligor);
  const res = await fetch(`${PAYMENTS_URL}/balance?${params.toString()}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) throw new Error(`/balance failed: HTTP ${res.status}`);
  // The endpoint nests the figures under `balance`:
  //   { status, timestamp, balance: { private_balance, decimals, … }, error }
  // (fall back to a flat shape just in case a deployment returns one).
  const json = (await res.json()) as {
    balance?: { private_balance?: string; decimals?: string } | null;
    private_balance?: string;
    decimals?: string;
  };
  const b = json.balance ?? json;
  return {
    raw: b?.private_balance ?? '0',
    decimals: b?.decimals ?? '1000000000000000000',
  };
}

/** Raw message record from the payments status endpoint. `executed`
 *  flips non-null when the on-chain operation settled. */
export interface MessageRecord {
  id?: string;
  status?: string;
  executed?: string | null;
  response?: { status?: string; success?: boolean; error?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/** A message is keyed under the SUBMITTING identity — a message a
 *  property group submitted (e.g. a rent collect) must be polled with
 *  the GROUP's entity id and the group-delegation bearer, not the
 *  user's. */
export async function getMessage(
  ownerId: string,
  messageId: string,
  token?: string | null
): Promise<MessageRecord> {
  const bearer = token ?? tokenManager.getCurrentToken();
  const res = await fetch(
    `${PAYMENTS_URL}/api/users/${ownerId}/messages/${messageId}`,
    { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }
  );
  if (!res.ok) {
    throw new Error(`message status poll failed: HTTP ${res.status}`);
  }
  return (await res.json()) as MessageRecord;
}

/**
 * Poll a message every 2s until it settles on chain (`executed` set)
 * or fails. `onPoll` fires after every poll so callers can render a
 * live status line.
 */
export async function waitForMessage(
  ownerId: string,
  messageId: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    token?: string | null;
    onPoll?: (msg: MessageRecord) => void;
  } = {}
): Promise<MessageRecord> {
  const { intervalMs = 2000, timeoutMs = 180_000, token, onPoll } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const msg = await getMessage(ownerId, messageId, token);
    onPoll?.(msg);

    const resp = msg.response;
    const statusStr = String(resp?.status ?? msg.status ?? '').toLowerCase();
    const failed =
      ['failed', 'error', 'canceled', 'cancelled'].includes(statusStr) ||
      resp?.success === false ||
      resp?.error != null;
    if (failed) {
      const detail = resp?.error ?? resp ?? msg.status ?? 'unknown error';
      throw new Error(
        `operation failed on chain: ${
          typeof detail === 'string' ? detail : JSON.stringify(detail)
        }`
      );
    }
    if (msg.executed) return msg;

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `message ${messageId} did not settle within ${timeoutMs / 1000}s`
  );
}

/** Fresh idempotency key per submission. NEVER derive one
 *  deterministically from the inputs — the resolver dedupes on it, so
 *  a retry after a stuck message would just return the stuck
 *  messageId again without re-enqueueing. */
export function freshIdempotencyKey(): string {
  const c = window.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  return `yfr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
