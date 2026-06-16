/**
 * Service URLs.
 *
 * The wallet-SDK reads its own env vars directly
 * (`REACT_APP_AUTH_SERVICE_URL`, `REACT_APP_PAYMENTS_SERVICE_URL`,
 * `REACT_APP_API_URL`) — see `.env.example`. This module carries the
 * surfaces THIS app calls itself.
 *
 * A consumer app talks to a small, fixed set of YieldFabric surfaces
 * (https://yieldfabric.com/docs/guides/building-with-yf). This rental
 * app uses three:
 *
 *   AUTH_URL  →  auth.yieldfabric.com
 *       REST — `/protected/jwt` identity lookup. (Sign-in, refresh, and
 *       the group delegation JWT are SDK-owned and read
 *       REACT_APP_AUTH_SERVICE_URL directly.)
 *   GATEWAY_GRAPHQL_URL  →  api.yieldfabric.com/graphql
 *       Federated GraphQL — the DMS deal-flow namespace (`dealFlow { … }`,
 *       served by the agents subgraph) plus cross-service READS
 *       (rent-schedule contracts, the entity directory, the asset catalog).
 *   PAYMENTS_URL  →  pay.yieldfabric.com
 *       Payments-direct GraphQL — the on-chain MUTATIONS the DMS doesn't
 *       wrap (collect / exchange / settle) — plus the balance and
 *       message-status polling REST endpoints.
 *
 * Why deal-flow goes through the gateway and the money loop goes
 * payments-direct: the deal lifecycle (saveDealDraft / proposeDraft /
 * signDeal / activateDeal) lives on the agents subgraph and is composed
 * by the federation gateway — the same client the first-party app uses
 * for it. The collect/exchange/settle mutations submit on-chain work,
 * which always rides the payments-direct route.
 */
export const AUTH_URL =
  process.env.REACT_APP_AUTH_SERVICE_URL || 'https://auth.yieldfabric.com';

export const PAYMENTS_URL =
  process.env.REACT_APP_PAYMENTS_SERVICE_URL || 'https://pay.yieldfabric.com';

export const GATEWAY_GRAPHQL_URL =
  process.env.REACT_APP_GRAPHQL_GATEWAY_URL ||
  'https://api.yieldfabric.com/graphql';
