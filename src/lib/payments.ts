/**
 * The on-chain rent money loop + the reads that drive it.
 *
 * The DMS sets a rental UP (group account, send policy, rent obligation,
 * tenant accept). The recurring money loop AFTER activation is plain
 * payments-direct work — and because the rent lands in a property GROUP
 * account, the landlord side runs acting AS the group, under a cached
 * delegation JWT (see `lib/delegation.ts`):
 *
 *   COLLECT  (landlord) — claim a due rent leg into the property account
 *                         as tenant CREDIT      → `accept`
 *   EXCHANGE (landlord) — turn that credit into a cash swap request
 *                         the tenant can settle  → `swapObligorPayment`
 *   SETTLE   (tenant)   — pay cash, clearing the credit they owe
 *                                                → `completeSwap`
 *
 * Reads: the rent-schedule contracts (for per-leg status), the entity
 * directory (for friendly names + the party pickers), the property
 * balance (cash vs tenant-credit), and the tenant's open exchange swaps.
 *
 * Every mutation returns at enqueue (a `messageId`); confirm settlement
 * by polling the message-status endpoint (`waitForMessage`). A
 * group-submitted message is keyed under the GROUP's entity id and must
 * be polled with the group bearer.
 */
import { gatewayQuery, paymentsMutation, paymentsQuery, fetchBalance, waitForMessage } from './graphql';
import { groupDelegationJwt } from './delegation';
import {
  deriveSchedulePayments,
  vaultBalanceToHuman,
  formatWei,
  formatDueDate,
  type RentContractLike,
  type RentalModel,
  type ScheduleLegStatus,
} from './rentalModel';

// ── Reads (federated gateway) ────────────────────────────────────────

export interface EntityOption {
  id: string;
  name: string;
  entityType?: string | null;
  defaultWallets?: Array<{ id: string; name?: string; address?: string; chainId?: number }>;
}

const ENTITIES_QUERY = `
  query GetEntitiesMinimal {
    entities {
      all {
        id
        name
        entityType
        defaultWallets { id name address chainId }
      }
    }
  }
`;

export async function fetchEntities(): Promise<EntityOption[]> {
  const data = await gatewayQuery<{ entities: { all: EntityOption[] } }>(ENTITIES_QUERY);
  return data.entities?.all ?? [];
}

const RENT_SCHEDULE_QUERY = `
  query GetRentScheduleContracts {
    contractFlow {
      coreContracts {
        all {
          id
          name
          manager { id }
          parties { entity { id } }
          payments {
            id
            status
            dueDate
            unlockReceiver
            payee { entity { id } wallet { id } }
          }
        }
      }
    }
  }
`;

export async function fetchRentScheduleContracts(): Promise<RentContractLike[]> {
  const data = await gatewayQuery<{
    contractFlow?: { coreContracts?: { all?: RentContractLike[] } };
  }>(RENT_SCHEDULE_QUERY);
  return data.contractFlow?.coreContracts?.all ?? [];
}

// ── Property-account balance (cash vs tenant-credit) ─────────────────

export interface PropertyBalance {
  /** Liquid cash the property account holds (human). */
  cash: string;
  /** Credit held against the tenant — claimed-but-unsettled rent (human). */
  credit: string;
  /** Raw credit balance — what `swapObligorPayment` takes. */
  creditRaw: string;
}

/** Two `/balance` reads, acting AS the property group: one without an
 *  obligor (cash), one bound to the tenant (credit). */
export async function fetchPropertyBalance(args: {
  denominationAssetId: string;
  tenantEntityId: string;
  groupEntityId: string;
}): Promise<PropertyBalance> {
  const token = await groupDelegationJwt(args.groupEntityId);
  const [cash, credit] = await Promise.all([
    fetchBalance(args.denominationAssetId, { token }),
    fetchBalance(args.denominationAssetId, { obligor: args.tenantEntityId, token }),
  ]);
  return {
    cash: vaultBalanceToHuman(cash.raw, cash.decimals),
    credit: vaultBalanceToHuman(credit.raw, credit.decimals),
    creditRaw: credit.raw,
  };
}

// ── COLLECT — claim a due rent leg into the property account ──────────

interface SimpleMutationResult {
  success?: boolean;
  message?: string;
  messageId?: string;
}

/** Claim a due leg as tenant credit. Runs acting AS the payee (property
 *  group) — the same `accept(paymentId, walletId)` the wallets page
 *  uses. */
export async function collectRentLeg(leg: ScheduleLegStatus): Promise<SimpleMutationResult> {
  if (!leg.paymentId || !leg.payeeEntityId) {
    throw new Error('leg is not collectable (no paymentId / payee group)');
  }
  const token = await groupDelegationJwt(leg.payeeEntityId);
  const data = await paymentsMutation<{ accept: SimpleMutationResult }>(
    'mutation AcceptPayment($input: AcceptInput!) { accept(input: $input) { success message messageId } }',
    { input: { paymentId: leg.paymentId, walletId: leg.payeeWalletId ?? undefined } },
    token
  );
  if (!data.accept?.success) {
    throw new Error(data.accept?.message || 'collect rejected');
  }
  return data.accept;
}

/** Poll the rent-schedule contracts until `paymentId` reads `credited`
 *  (or the budget runs out). The collect settles asynchronously — the
 *  payment row only flips to COMPLETED once the executor has run the
 *  on-chain retrieve and the post-processor has written the status. */
export async function pollLegCredited(
  model: Pick<RentalModel, 'schedule' | 'tenantEntityId' | 'propertyName'>,
  paymentId: string,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const { attempts = 12, intervalMs = 2500 } = opts;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const all = await fetchRentScheduleContracts();
    const credited = deriveSchedulePayments(model, all).some(
      (l) => l.paymentId === paymentId && l.state === 'credited'
    );
    if (credited) return true;
  }
  return false;
}

// ── EXCHANGE — turn collected credit into a cash swap ────────────────

/** Request a credit↔cash exchange the tenant can settle. Runs acting AS
 *  the property group; pays the obligor-bound credit, the tenant pays
 *  the same amount as cash. */
export async function exchangeCredit(args: {
  denominationAssetId: string;
  creditRaw: string;
  tenantEntityId: string;
  groupEntityId: string;
}): Promise<SimpleMutationResult & { swapId?: string }> {
  const token = await groupDelegationJwt(args.groupEntityId);
  const data = await paymentsMutation<{
    swapObligorPayment: SimpleMutationResult & { swapId?: string };
  }>(
    'mutation SwapObligorPayment($input: SwapObligorPaymentInput!) { swapObligorPayment(input: $input) { success message swapId messageId } }',
    {
      input: {
        denomination: args.denominationAssetId,
        amount: args.creditRaw,
        obligor: args.tenantEntityId,
      },
    },
    token
  );
  if (!data.swapObligorPayment?.success) {
    throw new Error(data.swapObligorPayment?.message || 'exchange request rejected');
  }
  return data.swapObligorPayment;
}

// ── SETTLE — tenant pays cash to clear the credit they owe ───────────

export interface OpenExchange {
  swapId: string;
  status: string;
  createdAt: string;
  parties?: Array<{ role: string; entity: { id: string; name: string } }>;
  payments?: Array<{ amount: string }>;
  counterpartyExpectedPayments?: unknown;
  initiatorExpectedPayments?: unknown;
}

/** The exchange swaps the caller is a party to (the tenant's open
 *  "settle & pay" list). Caller-scoped — runs under the tenant's own
 *  bearer. */
export async function fetchOpenExchanges(entityId: string): Promise<OpenExchange[]> {
  const data = await gatewayQuery<{
    swapFlow?: { coreSwaps?: { byEntityId?: OpenExchange[] } };
  }>(
    'query RentalExchangeSwaps($entityId: String!) { swapFlow { coreSwaps { byEntityId(entityId: $entityId) { swapId status createdAt parties { role entity { id name } } payments { amount } counterpartyExpectedPayments initiatorExpectedPayments } } } }',
    { entityId }
  );
  return data.swapFlow?.coreSwaps?.byEntityId ?? [];
}

/** Tenant settles an exchange: pays cash and receives their own credit
 *  back (which extinguishes what they owe). Runs under the tenant's own
 *  bearer. */
export async function settleExchange(swapId: string): Promise<SimpleMutationResult> {
  const data = await paymentsMutation<{ completeSwap: SimpleMutationResult }>(
    'mutation CompleteSwap($input: CompleteSwapInput!) { completeSwap(input: $input) { success message messageId } }',
    { input: { swapId } }
  );
  if (!data.completeSwap?.success) {
    throw new Error(data.completeSwap?.message || 'settle rejected');
  }
  return data.completeSwap;
}

// ── Property account: incoming payments + recent activity ────────────
//
// These read as the property GROUP, so they go payments-direct under the
// group-delegation JWT (the resolvers are caller-scoped). The landlord
// (and a group-member agent) accepts incoming cash into the account and
// browses its merged history.

export interface PropertyIncoming {
  id: string;
  amount: string | null;
  currency: string | null;
  from: string | null;
  walletId: string | null;
}

const INCOMING_QUERY =
  'query IncomingPayments { paymentsByEntity { id amount canAccept asset { currency } payee { wallet { id } } payer { entity { name } } } }';

/** `paymentsByEntity` is caller-scoped — `canAccept` is computed for
 *  whoever the bearer is. The property account reads it as the group
 *  (delegation token); the tenant reads their own (own token). */
async function fetchIncomingRows(
  token: string | null | undefined,
  excludeRentLegs: boolean
): Promise<PropertyIncoming[]> {
  const data = await paymentsQuery<{
    paymentsByEntity: Array<{
      id?: string;
      amount?: unknown;
      canAccept?: boolean;
      asset?: { currency?: string | null } | null;
      payee?: { wallet?: { id?: string } | null } | null;
      payer?: { entity?: { name?: string } | null } | null;
    }>;
  }>(INCOMING_QUERY, undefined, token);
  return (data.paymentsByEntity ?? [])
    .filter(
      (p) =>
        p?.canAccept === true &&
        !!p.id &&
        (!excludeRentLegs || !String(p.id).startsWith('PAY-INITIAL-'))
    )
    .map((p) => ({
      id: String(p.id),
      amount: formatWei(p.amount as string | number | undefined),
      currency: p.asset?.currency ?? null,
      from: p.payer?.entity?.name ?? null,
      walletId: p.payee?.wallet?.id ?? null,
    }));
}

/** Payments awaiting the PROPERTY account's acceptance — e.g. the cash a
 *  tenant pays at settlement. Acting as the group; rent legs
 *  (`PAY-INITIAL-…`) are excluded (those use the schedule's Collect). */
export async function fetchPropertyIncoming(groupEntityId: string): Promise<PropertyIncoming[]> {
  return fetchIncomingRows(await groupDelegationJwt(groupEntityId), true);
}

/** Payments awaiting the caller's OWN acceptance (the tenant claiming
 *  money sent to them) — read under their own token. */
export async function fetchTenantIncoming(): Promise<PropertyIncoming[]> {
  return fetchIncomingRows(undefined, false);
}

/** Accept an incoming payment INTO the property account (acting as the
 *  group), then poll to settlement under the GROUP identity (the message
 *  row is keyed under the submitter). */
export async function acceptPropertyIncoming(args: {
  paymentId: string;
  walletId?: string;
  groupEntityId: string;
}): Promise<void> {
  const token = await groupDelegationJwt(args.groupEntityId);
  const data = await paymentsMutation<{ accept: SimpleMutationResult }>(
    'mutation AcceptIntoProperty($input: AcceptInput!) { accept(input: $input) { success message messageId } }',
    { input: { paymentId: args.paymentId, walletId: args.walletId ?? undefined } },
    token
  );
  if (!data.accept?.success) {
    throw new Error(data.accept?.message || 'accept rejected');
  }
  if (data.accept.messageId) {
    await waitForMessage(args.groupEntityId, data.accept.messageId, { token });
  }
}

/** Accept an incoming payment into the caller's OWN wallet (the tenant
 *  claiming money sent to them), then poll under their own identity. */
export async function acceptTenantIncoming(args: {
  paymentId: string;
  walletId?: string;
  ownerEntityId: string;
}): Promise<void> {
  const data = await paymentsMutation<{ accept: SimpleMutationResult }>(
    'mutation AcceptIncoming($input: AcceptInput!) { accept(input: $input) { success message messageId } }',
    { input: { paymentId: args.paymentId, walletId: args.walletId ?? undefined } }
  );
  if (!data.accept?.success) {
    throw new Error(data.accept?.message || 'accept rejected');
  }
  if (data.accept.messageId) {
    await waitForMessage(args.ownerEntityId, data.accept.messageId);
  }
}

/** Friendly names for MQ operation types in the wallet activity feed. */
const ACTIVITY_OP_LABELS: Record<string, string> = {
  ExecuteUnderPolicy: 'Send under policy',
  Send: 'Payment sent',
  Retrieve: 'Payment collected',
  CreatePaymentSwap: 'Exchange requested',
  CreateObligationSwap: 'Exchange requested',
  CompleteSwap: 'Settlement completed',
  CancelSwap: 'Exchange cancelled',
  DeployAccount: 'Account created',
  AddDataPolicy: 'Policy registered',
  CreateObligation: 'Rent obligation created',
  AcceptObligation: 'Lease accepted',
};
function activityOpLabel(t: string): string {
  return ACTIVITY_OP_LABELS[t] ?? t.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export interface ActivityRow {
  key: string;
  label: string;
  when: string | null;
  failed: boolean;
  pending: boolean;
}

interface RawActivityItem {
  __typename?: string;
  timestamp?: string;
  payment?: {
    id?: string;
    amount?: unknown;
    status?: string;
    payer?: { entity?: { name?: string } | null; wallet?: { id?: string } | null } | null;
    payee?: { entity?: { name?: string } | null; wallet?: { id?: string } | null } | null;
  } | null;
  message?: { id?: string; messageType?: string; status?: string } | null;
}

/** A wallet's merged history (`walletFlow.activity`) — payments in/out plus
 *  on-chain operations, newest first. Direction is relative to `walletId`.
 *  Pass `groupEntityId` to read a property GROUP wallet (delegation token);
 *  omit it to read the caller's OWN wallet (own token). */
export async function fetchWalletActivity(args: {
  walletId: string;
  denomination: string | null;
  limit?: number;
  groupEntityId?: string;
}): Promise<ActivityRow[]> {
  const token = args.groupEntityId ? await groupDelegationJwt(args.groupEntityId) : undefined;
  const data = await paymentsQuery<{
    walletFlow?: { activity?: { items?: RawActivityItem[] } };
  }>(
    'query PropertyActivity($walletId: String!, $limit: Int) { walletFlow { activity(walletId: $walletId, limit: $limit) { items { __typename ... on PaymentActivity { timestamp payment { id amount status payer { entity { name } wallet { id } } payee { entity { name } wallet { id } } } } ... on MessageActivity { timestamp message { id messageType status } } } } } }',
    { walletId: args.walletId, limit: args.limit ?? 6 },
    token
  );
  const items = data.walletFlow?.activity?.items ?? [];
  const denom = args.denomination ?? '';
  return items.map((it, i): ActivityRow => {
    const when = typeof it?.timestamp === 'string' ? formatDueDate(it.timestamp) : null;
    if (it?.__typename === 'PaymentActivity' && it?.payment) {
      const p = it.payment;
      const outgoing = p?.payer?.wallet?.id === args.walletId;
      const other = (outgoing ? p?.payee?.entity?.name : p?.payer?.entity?.name) ?? null;
      const amt = formatWei(p?.amount as string | number | undefined);
      const status = String(p?.status ?? '').toUpperCase();
      return {
        key: `pay-${p?.id ?? i}`,
        label:
          `${outgoing ? 'Sent' : 'Received'}` +
          (amt ? ` ${amt} ${denom}`.trimEnd() : '') +
          (other ? ` ${outgoing ? 'to' : 'from'} ${other}` : ''),
        when,
        failed: ['FAILED', 'CANCELLED', 'CANCELED'].includes(status),
        pending: !['COMPLETED', 'PAID', 'FAILED', 'CANCELLED', 'CANCELED'].includes(status),
      };
    }
    const m = it?.message ?? {};
    const status = String(m?.status ?? '');
    return {
      key: `msg-${m?.id ?? i}`,
      label: activityOpLabel(String(m?.messageType ?? 'Operation')),
      when,
      failed: /fail|error|cancel/i.test(status),
      pending: !/complete/i.test(status) && !/fail|error|cancel/i.test(status),
    };
  });
}
