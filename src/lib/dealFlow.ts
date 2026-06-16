/**
 * The DMS deal-flow client — the rental's lifecycle, end to end.
 *
 * A rental on YieldFabric is NOT a bespoke backend entity and is NOT a
 * raw obligation mint. It is a **Deal**: a counter-signed agreement
 * carrying a `DealPlan` (a small DAG of typed action nodes). You author
 * the plan, the counterparties sign it, you activate it — and the DMS
 * engine compiles the plan and submits the underlying on-chain work
 * (group-account creation, the managing-agent send policy, the rent
 * obligation, the tenant's accept) on the parties' behalf.
 *
 * The deal-flow GraphQL is federated under the `dealFlow` namespace
 * (served by the agents subgraph) and composed by the gateway, so every
 * field nests under `data.dealFlow.<op>` and every call here rides
 * `gatewayQuery` / `gatewayMutation` (the federated gateway) — not the
 * payments-direct route the on-chain money loop uses.
 *
 * Lifecycle: saveDealDraft → proposeDraft → (counterparty) signDeal →
 * activateDeal. Plus the two-sided automation credential
 * (setDealAutomationKey / revokeDealAutomationKey) the rent worker fires
 * under.
 *
 * Docs: https://yieldfabric.com/docs/guides/dms and
 * https://yieldfabric.com/docs/guides/deal-lifecycle
 */
import { gatewayQuery, gatewayMutation } from './graphql';
import type {
  Deal,
  DealAutomationStatus,
  DealMutationResponse,
  DealPeriodView,
  DealStatus,
  PartyActionResponse,
  PendingAction,
  ProcessDealPeriodResponse,
  SaveDealDraftInput,
  SetDealAutomationKeyInput,
} from './dealTypes';

/** Core scalar fields on a Deal — matches the first-party app's
 *  `DealCoreFields` fragment. */
const DEAL_CORE_FIELDS = `
  fragment DealCoreFields on Deal {
    id
    kind
    name
    status
    plan
    planHash
    proposerEntityId
    parties { entityId role }
    parentDealId
    cashflowRef
    workflowId
    versionAt
    acceptedAt
    completedAt
    cancelledAt
    deleted
    transactionId
  }
`;

/** Every rental the caller is a party to (landlord, tenant, or agent),
 *  newest activity first per the resolver. Filter to rentals with
 *  `isRentalDeal` (rentalModel) on the client. */
export async function listMyDeals(status?: DealStatus): Promise<Deal[]> {
  const query = `
    query GetDealsByParty($role: PartyRoleFilter, $status: DealStatus) {
      dealFlow {
        dealsByParty(role: $role, status: $status) {
          ...DealCoreFields
        }
      }
    }
    ${DEAL_CORE_FIELDS}
  `;
  const data = await gatewayQuery<{ dealFlow: { dealsByParty: Deal[] } }>(query, {
    role: null,
    status: status ?? null,
  });
  return data.dealFlow?.dealsByParty ?? [];
}

/** Save (or update) a rental draft. `draftId: null` creates a new draft
 *  and the response Deal carries the generated `DEAL-<uuid>`; pass that
 *  id back to append a new version. */
export async function saveDealDraft(input: SaveDealDraftInput): Promise<Deal> {
  const mutation = `
    mutation SaveDealDraft($input: SaveDealDraftInput!) {
      dealFlow {
        saveDealDraft(input: $input) {
          ...DealCoreFields
        }
      }
    }
    ${DEAL_CORE_FIELDS}
  `;
  const data = await gatewayMutation<{ dealFlow: { saveDealDraft: Deal } }>(mutation, {
    input,
  });
  return data.dealFlow.saveDealDraft;
}

/** Propose a stored draft to its counterparties for signing
 *  (DRAFT → PROPOSED). */
export async function proposeDraft(draftId: string): Promise<DealMutationResponse> {
  const mutation = `
    mutation ProposeDraft($input: ProposeDraftInput!) {
      dealFlow {
        proposeDraft(input: $input) {
          success
          message
          deal { ...DealCoreFields }
        }
      }
    }
    ${DEAL_CORE_FIELDS}
  `;
  const data = await gatewayMutation<{ dealFlow: { proposeDraft: DealMutationResponse } }>(
    mutation,
    { input: { draftId, revisionId: null } }
  );
  return data.dealFlow.proposeDraft;
}

/** Counter-signing party accepts the proposed rental
 *  (their signature; the deal activates once every party has signed and
 *  the proposer activates). */
export async function signDeal(dealId: string): Promise<DealMutationResponse> {
  const mutation = `
    mutation SignDeal($input: SignDealInput!) {
      dealFlow {
        signDeal(input: $input) {
          success
          message
          deal { ...DealCoreFields }
        }
      }
    }
    ${DEAL_CORE_FIELDS}
  `;
  const data = await gatewayMutation<{ dealFlow: { signDeal: DealMutationResponse } }>(
    mutation,
    { input: { dealId } }
  );
  return data.dealFlow.signDeal;
}

/** Proposer activates the signed rental — the DMS compiles the plan and
 *  submits the on-chain work (property account → send policy → rent
 *  obligation → tenant accept). PROPOSED/ACCEPTED → ACTIVE. */
export async function activateDeal(dealId: string): Promise<DealMutationResponse> {
  const mutation = `
    mutation ActivateDeal($input: ActivateDealInput!) {
      dealFlow {
        activateDeal(input: $input) {
          success
          message
          deal { ...DealCoreFields }
        }
      }
    }
    ${DEAL_CORE_FIELDS}
  `;
  const data = await gatewayMutation<{ dealFlow: { activateDeal: DealMutationResponse } }>(
    mutation,
    { input: { dealId } }
  );
  return data.dealFlow.activateDeal;
}

// ── Two-sided automation (auto-collect / auto-settle) ────────────────

/** Live auto-pay status for a deal — a LIST, one row per arming party
 *  (the landlord's auto-collect row and the tenant's auto-settle row).
 *  Filter by `entityId`. */
export async function dealAutomationStatus(dealId: string): Promise<DealAutomationStatus[]> {
  const query = `
    query DealAutomationStatus($dealId: String!) {
      dealFlow {
        dealAutomationStatus(dealId: $dealId) {
          active
          entityId
          role
          keyLabel
          createdAt
        }
      }
    }
  `;
  const data = await gatewayQuery<{ dealFlow: { dealAutomationStatus: DealAutomationStatus[] } }>(
    query,
    { dealId }
  );
  return data.dealFlow?.dealAutomationStatus ?? [];
}

/** Arm auto-pay: store the caller's sealed `yf_api_…` credential against
 *  the deal. The rent worker then drives the caller's side (collect for
 *  the landlord, settle for the tenant) unattended. */
export async function setDealAutomationKey(
  input: SetDealAutomationKeyInput
): Promise<DealAutomationStatus> {
  const mutation = `
    mutation SetDealAutomationKey($input: SetDealAutomationKeyInput!) {
      dealFlow {
        setDealAutomationKey(input: $input) {
          active
          entityId
          role
          keyLabel
          createdAt
        }
      }
    }
  `;
  const data = await gatewayMutation<{ dealFlow: { setDealAutomationKey: DealAutomationStatus } }>(
    mutation,
    { input }
  );
  return data.dealFlow.setDealAutomationKey;
}

/** Stop auto-pay (the kill-switch) — revokes the stored credential so
 *  the worker stops firing the caller's side. */
export async function revokeDealAutomationKey(dealId: string): Promise<DealAutomationStatus> {
  const mutation = `
    mutation RevokeDealAutomationKey($input: RevokeDealAutomationKeyInput!) {
      dealFlow {
        revokeDealAutomationKey(input: $input) {
          active
          entityId
          role
          keyLabel
          createdAt
        }
      }
    }
  `;
  const data = await gatewayMutation<{ dealFlow: { revokeDealAutomationKey: DealAutomationStatus } }>(
    mutation,
    { input: { dealId } }
  );
  return data.dealFlow.revokeDealAutomationKey;
}

// ── Executing the deal's steps to completion ─────────────────────────

const PENDING_ACTION_FIELDS = `
  fragment PendingActionFields on PendingAction {
    id
    dealId
    workflowId
    stepId
    descriptorName
    assigneeKind
    assigneeEntityId
    status
    createdAt
  }
`;

/** The in-DAG steps a deal is waiting on a party to execute. Empty
 *  before activation; populated as the workflow reaches each
 *  party-assigned step (e.g. the tenant's `accept_rent`). */
export async function pendingActionsForDeal(dealId: string): Promise<PendingAction[]> {
  const query = `
    query GetPendingActionsForDeal($dealId: String!) {
      dealFlow {
        pendingActionsForDeal(dealId: $dealId) {
          ...PendingActionFields
        }
      }
    }
    ${PENDING_ACTION_FIELDS}
  `;
  const data = await gatewayQuery<{ dealFlow: { pendingActionsForDeal: PendingAction[] } }>(query, {
    dealId,
  });
  return data.dealFlow?.pendingActionsForDeal ?? [];
}

/** Execute one of the deal's awaiting steps. The DMS runs the underlying
 *  op (op-then-sign for payment steps) under the caller's identity,
 *  advances the pending-action lifecycle (PENDING → IN_PROGRESS →
 *  COMPLETED), and walks the DAG forward. `outputs` is the descriptor's
 *  expected output payload — `{}` for the rental's steps, which carry
 *  their inputs sealed server-side. */
export async function completePartyAction(
  actionId: string,
  outputs: Record<string, unknown> = {}
): Promise<PartyActionResponse> {
  const mutation = `
    mutation CompletePartyAction($input: CompletePartyActionInput!) {
      dealFlow {
        completePartyAction(input: $input) {
          success
          message
        }
      }
    }
  `;
  const data = await gatewayMutation<{ dealFlow: { completePartyAction: PartyActionResponse } }>(
    mutation,
    { input: { actionId, outputs } }
  );
  return data.dealFlow.completePartyAction;
}

// ── Periodic deals (loans) — the per-period repayment ledger ─────────

/** The runtime period ledger for a periodic deal (a loan's repayment
 *  periods). Empty for one-shot deals (rentals). The scheduler advances
 *  rows SCHEDULED → PROCESSING → COMPLETED in the background. */
export async function dealPeriods(dealId: string): Promise<DealPeriodView[]> {
  const query = `
    query DealPeriods($dealId: String!) {
      dealFlow {
        dealPeriods(dealId: $dealId) {
          periodIndex
          status
          dueAt
          workflowId
          startedAt
          completedAt
          hasRealised
        }
      }
    }
  `;
  const data = await gatewayQuery<{ dealFlow: { dealPeriods: DealPeriodView[] } }>(query, { dealId });
  return data.dealFlow?.dealPeriods ?? [];
}

/** Advance one period — the borrower's repayment for that period (the
 *  cashflow engine splits it into interest + principal and pays the
 *  lender). The auto-pay scheduler fires this under the borrower's stored
 *  key; this is the manual path. */
export async function processDealPeriod(
  dealId: string,
  periodIndex: number
): Promise<ProcessDealPeriodResponse> {
  const mutation = `
    mutation ProcessDealPeriod($input: ProcessDealPeriodInput!) {
      dealFlow {
        processDealPeriod(input: $input) {
          success
          dealId
          periodIndex
          status
          message
        }
      }
    }
  `;
  const data = await gatewayMutation<{ dealFlow: { processDealPeriod: ProcessDealPeriodResponse } }>(
    mutation,
    { input: { dealId, periodIndex } }
  );
  return data.dealFlow.processDealPeriod;
}
