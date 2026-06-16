/**
 * Documentation deep-links shown throughout this tutorial app.
 *
 * Every UI surface that demonstrates a platform concept links to the
 * page that explains it — the guide for the narrative, the API
 * reference for the wire contract. Override the base for a
 * self-hosted docs site via REACT_APP_DOCS_BASE_URL.
 */
const DOCS_BASE = process.env.REACT_APP_DOCS_BASE_URL || 'https://yieldfabric.com';

export const DOCS = {
  /** The deal-management system — the narrative this whole app follows. */
  dms: `${DOCS_BASE}/docs/guides/dms`,
  dealLifecycle: `${DOCS_BASE}/docs/guides/deal-lifecycle`,
  /** Loans — the periodic, amortizing sibling of the rental deal. */
  loans: `${DOCS_BASE}/docs/guides/loans`,
  /** Building with YF — the public API surface + wire rules. */
  buildingWithYf: `${DOCS_BASE}/docs/guides/building-with-yf`,
  auth: `${DOCS_BASE}/docs/guides/building-with-yf#authenticate-in-30-seconds`,
  /** Obligations + composed operations — what a rent lease is made of. */
  obligationLifecycle: `${DOCS_BASE}/docs/guides/obligation-lifecycle`,
  composedOperations: `${DOCS_BASE}/docs/guides/composed-operations`,
  /** Delegation — acting as the property group account. */
  delegation: `${DOCS_BASE}/docs/guides/delegation`,
  /** Data policies — the managing-agent's balance-gated send authority. */
  dataPolicies: `${DOCS_BASE}/docs/guides/data-policies`,
  /** Payment lifecycle + settlement polling. */
  paymentLifecycle: `${DOCS_BASE}/docs/guides/payment-lifecycle`,
  /** Signatures — the manual-signing drawer for external signers. */
  signatures: `${DOCS_BASE}/docs/guides/signatures`,
  /** API references. */
  paymentsApi: `${DOCS_BASE}/docs/api/payments`,
  agentsApi: `${DOCS_BASE}/docs/api/agents`,
};
