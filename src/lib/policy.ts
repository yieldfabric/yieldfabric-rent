/**
 * The managing-agent send policy — read + lifecycle.
 *
 * A rental's `add_data_policy` step registers an on-chain, balance-gated
 * authorisation that lets the managing agent disburse from the property
 * account while constraints hold (a per-send cap, a balance floor, an
 * expiry, a use count). This module is the policy surface the landlord
 * (account owner) and agent (executor) use after activation:
 *
 *   READ      `pipelineGate.dataPolicies` + per-policy `dataPolicyApproval`
 *   APPROVE   the landlord (required signer) records their signature —
 *             the reusable M-of-N artifact every send re-attaches
 *   ADD       register an additional policy
 *   NOVATE    register a SUCCESSOR with amended terms (the chain forbids
 *             in-place edits + has no revoke on old accounts — the
 *             predecessor stays valid until it ages out)
 *   REVOKE    remove a policy on-chain (`removeDataPolicy`, new accounts)
 *   SEND      the agent (or landlord) disburses under the policy
 *             (`executeUnderPolicy`), bounded by the cap + floor
 *
 * Reads go under the caller's own token; the write/exec paths act as the
 * property group (delegation JWT — auto-narrowed for the agent executor).
 *
 * Docs: https://yieldfabric.com/docs/guides/data-policies
 */
import { paymentsQuery, paymentsMutation, waitForMessage } from './graphql';
import { groupDelegationJwt } from './delegation';
import { formatWei, humanToWei } from './rentalModel';

export interface PolicyBound {
  token: string;
  lo: string;
  hi: string;
}

export interface PolicyApproval {
  collected: number;
  min: number;
  approved: boolean;
  /** What each required signer personal_signs once. */
  registeredDigest: string;
}

export interface PolicyInfo {
  policyId: string;
  label: string;
  /** Per-send cap, humanized (from the first amount bound); null if open. */
  capHuman: string | null;
  allowedOperations: string[];
  maxUse: string;
  /** Executions consumed so far (live on-chain counter); null if unread. */
  uses: number | null;
  expiry: string;
  minSignatories: number;
  requiredSignerEntityIds: string[];
  executors: string[];
  bounds: PolicyBound[];
  approval: PolicyApproval | null;
  /** Removed on-chain — can never be approved or used again (Novate to replace). */
  revoked: boolean;
}

interface RawPolicy {
  policyId?: string;
  revoked?: boolean | null;
  allowedOperations?: string[] | null;
  maxUse?: string | null;
  uses?: number | null;
  expiry?: string | null;
  minSignatories?: number | null;
  requiredSignerEntityIds?: string[] | null;
  executors?: string[] | null;
  amountBounds?: Array<{ token?: string; lo?: string | null; hi?: string | null } | null> | null;
}

const POLICIES_QUERY =
  'query PropertyPolicies($walletId: String!) { pipelineGate { dataPolicies(walletId: $walletId, includeRevoked: true) { policyId revoked allowedOperations maxUse uses expiry minSignatories requiredSignerEntityIds executors amountBounds { token lo hi } } } }';
const APPROVAL_QUERY =
  'query PolicyApproval($account: String!, $policyId: String!) { pipelineGate { dataPolicyApproval(account: $account, policyId: $policyId) { collected minSignatories approved registeredDigest } } }';

/** The property account's registered policies (incl. revoked) + each live
 *  one's approval progress. Caller-scoped under the caller's own token —
 *  the account owner (landlord) and a registered executor (agent) can both
 *  read. */
export async function fetchPolicies(
  walletId: string,
  denomination: string | null
): Promise<PolicyInfo[]> {
  const data = await paymentsQuery<{ pipelineGate?: { dataPolicies?: RawPolicy[] } }>(
    POLICIES_QUERY,
    { walletId }
  );
  const rows = data.pipelineGate?.dataPolicies ?? [];
  const policies: PolicyInfo[] = rows
    .filter((r) => !!r?.policyId)
    .map((r) => {
      const capHuman = r.amountBounds?.[0]?.hi ? formatWei(r.amountBounds[0]?.hi) : null;
      return {
        policyId: String(r.policyId),
        label: capHuman
          ? `Policy ${r.policyId} — up to ${capHuman} ${denomination ?? ''} per send`
          : `Policy ${r.policyId}`,
        capHuman,
        allowedOperations: (r.allowedOperations ?? []).filter(Boolean) as string[],
        maxUse: String(r.maxUse ?? ''),
        uses: typeof r.uses === 'number' ? r.uses : null,
        expiry: String(r.expiry ?? ''),
        minSignatories: Number(r.minSignatories ?? 0),
        requiredSignerEntityIds: (r.requiredSignerEntityIds ?? []).filter(Boolean) as string[],
        executors: (r.executors ?? []).filter(Boolean) as string[],
        bounds: (r.amountBounds ?? [])
          .filter((b): b is NonNullable<typeof b> => !!b)
          .map((b) => ({ token: String(b.token ?? ''), lo: String(b.lo ?? '0'), hi: String(b.hi ?? '0') })),
        approval: null,
        revoked: !!r.revoked,
      };
    });

  // Per-policy approval progress (skip revoked — their artifact is gone).
  await Promise.all(
    policies.map(async (p) => {
      if (p.revoked) return;
      try {
        const a = await paymentsQuery<{
          pipelineGate?: {
            dataPolicyApproval?: {
              collected?: number;
              minSignatories?: number;
              approved?: boolean;
              registeredDigest?: string;
            } | null;
          };
        }>(APPROVAL_QUERY, { account: walletId, policyId: p.policyId });
        const ap = a.pipelineGate?.dataPolicyApproval;
        if (ap) {
          p.approval = {
            collected: Number(ap.collected ?? 0),
            min: Number(ap.minSignatories ?? 0),
            approved: !!ap.approved,
            registeredDigest: String(ap.registeredDigest ?? ''),
          };
        }
      } catch {
        /* leave approval null */
      }
    })
  );
  return policies;
}

/** Register a policy (Add or the SUCCESSOR of a Novate). Acts as the group;
 *  born-approved via the registrar auto-approval. */
export async function addDataPolicy(args: {
  account: string;
  policyId: string;
  expiryIso: string;
  maxUse: number;
  requiredSignerEntityId: string;
  executor: string;
  denomination: string;
  capHuman: string;
  floorHuman: string;
  groupEntityId: string;
}): Promise<void> {
  const token = await groupDelegationJwt(args.groupEntityId);
  const input = {
    account: args.account,
    walletId: args.account,
    policyId: args.policyId,
    expiry: args.expiryIso,
    maxUse: String(args.maxUse),
    minSignatories: 1,
    requiredSigners: [args.requiredSignerEntityId],
    requiredSignerEntityIds: [args.requiredSignerEntityId],
    executorAccounts: [args.executor],
    allowedOperations: ['send'],
    amountBounds:
      Number(args.capHuman) > 0
        ? [{ token: args.denomination, lo: '0', hi: humanToWei(args.capHuman) }]
        : [],
    requirements:
      Number(args.floorHuman) > 0
        ? [
            {
              source: 0,
              denomination: args.denomination,
              lo: humanToWei(args.floorHuman),
              hi: '1000000000000000000000000000',
            },
          ]
        : [],
  };
  const data = await paymentsMutation<{
    pipelineGate?: { addDataPolicy?: { success?: boolean; message?: string; messageId?: string } };
  }>(
    'mutation AddRentalPolicy($input: AddDataPolicyInput!) { pipelineGate { addDataPolicy(input: $input) { success message messageId } } }',
    { input },
    token
  );
  const out = data.pipelineGate?.addDataPolicy;
  if (!out?.success) throw new Error(out?.message || 'policy registration rejected');
  if (out.messageId) await waitForMessage(args.groupEntityId, out.messageId, { token });
}

/** Revoke a policy on-chain (Retire). Only accounts on the new
 *  implementation support it; older ones revert (use Novate instead). */
export async function removeDataPolicy(args: {
  account: string;
  policyId: string;
  groupEntityId: string;
}): Promise<void> {
  const token = await groupDelegationJwt(args.groupEntityId);
  const data = await paymentsMutation<{
    pipelineGate?: { removeDataPolicy?: { success?: boolean; message?: string; messageId?: string } };
  }>(
    'mutation RetireRentalPolicy($input: RemoveDataPolicyInput!) { pipelineGate { removeDataPolicy(input: $input) { success message messageId policyId } } }',
    { input: { account: args.account, walletId: args.account, policyId: args.policyId } },
    token
  );
  const out = data.pipelineGate?.removeDataPolicy;
  if (!out?.success) throw new Error(out?.message || 'policy removal rejected');
  if (out.messageId) {
    await waitForMessage(args.groupEntityId, out.messageId, { token });
  }
}

/** Record the landlord's (required signer's) approval signature over the
 *  policy's registered digest — the reusable M-of-N artifact. Runs under
 *  the signer's OWN token (it's their personal signature, not the group's).
 *  The `signature` is produced client-side via the wallet-SDK's generic
 *  signer with the OLDEST ACTIVE Signing key (the account-owner EOA). */
export async function approveDataPolicy(args: {
  account: string;
  policyId: string;
  signature: string;
}): Promise<void> {
  const data = await paymentsMutation<{
    pipelineGate?: { approveDataPolicy?: { success?: boolean; message?: string; approved?: boolean } };
  }>(
    'mutation ApproveDataPolicy($input: ApproveDataPolicyInput!) { pipelineGate { approveDataPolicy(input: $input) { success message signer collected approved registeredDigest } } }',
    { input: { account: args.account, policyId: args.policyId, signature: args.signature } }
  );
  const out = data.pipelineGate?.approveDataPolicy;
  if (!out?.success) throw new Error(out?.message || 'approval rejected');
}

/** Disburse from the property account UNDER the policy — the agent's
 *  bounded send (the chain enforces the cap + balance floor + use count).
 *  `tokenAddress` is the policy's bounded token (a 0x address);
 *  `destination` is the recipient address (a `WLT-`-stripped wallet id);
 *  `amountRaw` is raw 18-decimal units. Acts as the group. */
export async function sendUnderPolicy(args: {
  account: string;
  policyId: string;
  tokenAddress: string;
  destination: string;
  amountRaw: string;
  groupEntityId: string;
}): Promise<void> {
  const token = await groupDelegationJwt(args.groupEntityId);
  const data = await paymentsMutation<{
    pipelineGate?: { executeUnderPolicy?: { success?: boolean; message?: string; messageId?: string } };
  }>(
    'mutation AgentPolicySend($input: ExecuteUnderPolicyInput!) { pipelineGate { executeUnderPolicy(input: $input) { success message messageId approved collected } } }',
    {
      input: {
        account: args.account,
        policyId: args.policyId,
        operationType: 'Send',
        operationData: JSON.stringify({
          token_address: args.tokenAddress,
          destination_id: args.destination,
          amount: args.amountRaw,
        }),
      },
    },
    token
  );
  const out = data.pipelineGate?.executeUnderPolicy;
  if (!out?.success) throw new Error(out?.message || 'send under policy rejected');
  if (out.messageId) await waitForMessage(args.groupEntityId, out.messageId, { token });
}
