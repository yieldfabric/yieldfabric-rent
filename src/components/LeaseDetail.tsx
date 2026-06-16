import React from 'react';
import { Link } from 'react-router-dom';
import { apiKeysService } from '@yieldfabric/wallet';

import DocLink from './DocLink';
import PolicySection from './PolicySection';
import LifecycleStepper from './LifecycleStepper';
import { DOCS } from '../docs';
import { Pill, StatusPill, PaymentStateBadge } from './badges';
import { rentalStage, nextStep, ROLE_LABEL, type RentalRole } from '../lib/lifecycle';
import { waitForMessage, fetchBalance } from '../lib/graphql';
import { fetchJwtInfo } from '../lib/session';
import type { Deal, DealAutomationStatus, PendingAction } from '../lib/dealTypes';
import {
  proposeDraft,
  signDeal,
  activateDeal,
  dealAutomationStatus,
  setDealAutomationKey,
  revokeDealAutomationKey,
  pendingActionsForDeal,
  completePartyAction,
} from '../lib/dealFlow';
import {
  fetchRentScheduleContracts,
  fetchPropertyBalance,
  collectRentLeg,
  pollLegCredited,
  exchangeCredit,
  fetchOpenExchanges,
  settleExchange,
  fetchPropertyIncoming,
  acceptPropertyIncoming,
  fetchTenantIncoming,
  acceptTenantIncoming,
  fetchWalletActivity,
  type EntityOption,
  type OpenExchange,
  type PropertyBalance,
  type PropertyIncoming,
  type ActivityRow,
} from '../lib/payments';
import {
  parseRental,
  deriveSchedulePayments,
  formatCadence,
  vaultBalanceToHuman,
  FREQUENCY_PER_LABEL,
  type RentContractLike,
  type ScheduleLegStatus,
} from '../lib/rentalModel';

/**
 * The lease detail — a distilled `RentalControl`. One screen, four acts:
 *
 *   1. Lifecycle   — Send (propose) → Sign → Activate (DMS, gateway).
 *   2. Rent roll   — the schedule from the plan + on-chain leg statuses;
 *                    the landlord Collects a due leg (accept, group JWT).
 *   3. Money loop  — landlord exchanges credit for a cash swap, the
 *                    tenant settles it (payments-direct).
 *   4. Automation  — landlord arms auto-collect, tenant arms auto-settle.
 *
 * Which acts you see depends on your role on the deal (landlord =
 * proposer, tenant, or managing agent) — derived from your entity id.
 */

function Section({
  title,
  hint,
  docHref,
  docLabel,
  children,
}: {
  title: string;
  hint?: string;
  docHref?: string;
  docLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-sm font-semibold text-ink-deep">{title}</h3>
        {hint && !docHref && <span className="mini-label">{hint}</span>}
        {docHref && (
          <DocLink href={docHref} className="text-[11px] text-brand-600 hover:underline">
            {docLabel ?? 'docs'}
          </DocLink>
        )}
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-2 rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">
      {message}
    </div>
  );
}

/** Friendly labels for the rental plan's steps + the bridge verbs the
 *  DMS surfaces as pending-action descriptor names. */
const TASK_LABELS: Record<string, string> = {
  create_group_account: 'Create the property account',
  add_data_policy: 'Authorise the managing-agent send policy',
  create_composed_contract: 'Mint the rent obligation',
  accept_obligation: 'Tenant accepts (escrows the rent)',
};
function humanizeStep(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}
function stepLabel(name: string): string {
  return TASK_LABELS[name] ?? humanizeStep(name);
}

export default function LeaseDetail({
  deal,
  callerId,
  entities,
  onChanged,
}: {
  deal: Deal;
  callerId: string;
  entities: EntityOption[];
  onChanged: () => void;
}) {
  const model = React.useMemo(() => parseRental(deal), [deal]);

  const entityName = React.useCallback(
    (id: string | null | undefined): string => {
      if (!id) return '—';
      const e = entities.find((x) => x.id === id);
      return e?.name ?? `${id.slice(0, 12)}…`;
    },
    [entities]
  );

  const status = deal.status;
  const isDraft = status === 'DRAFT';
  const isProposed = status === 'PROPOSED';
  const isLive = status === 'ACTIVE' || status === 'COMPLETED';

  const isLandlord = !!model && callerId === model.landlordEntityId;
  const isTenant = !!model?.tenantEntityId && callerId === model.tenantEntityId;
  const isAgent = !!model?.agentEntityId && callerId === model.agentEntityId && !isLandlord;
  const isParty = deal.parties.some((p) => p.entityId === callerId);

  // ── Lifecycle (DMS) ────────────────────────────────────────────────
  const [lifeBusy, setLifeBusy] = React.useState<string | null>(null);
  const [lifeError, setLifeError] = React.useState<string | null>(null);
  const runLifecycle = async (
    kind: string,
    fn: () => Promise<{ success: boolean; message: string | null } | unknown>
  ) => {
    setLifeError(null);
    setLifeBusy(kind);
    try {
      const r = (await fn()) as { success?: boolean; message?: string | null } | undefined;
      if (r && r.success === false) throw new Error(r.message || `${kind} failed`);
      onChanged();
    } catch (e) {
      setLifeError((e as Error).message);
    } finally {
      setLifeBusy(null);
    }
  };

  // ── Rent schedule (read) ───────────────────────────────────────────
  const [contracts, setContracts] = React.useState<RentContractLike[]>([]);
  const reloadContracts = React.useCallback(async () => {
    if (isDraft) {
      setContracts([]);
      return;
    }
    try {
      setContracts(await fetchRentScheduleContracts());
    } catch {
      /* best-effort */
    }
  }, [isDraft]);
  React.useEffect(() => {
    void reloadContracts();
  }, [reloadContracts, deal.id, status]);

  const legs: ScheduleLegStatus[] = React.useMemo(() => {
    if (!model) return [];
    if (isDraft) {
      return model.schedule.map(() => ({
        state: 'scheduled' as const,
        paymentId: null,
        payeeWalletId: null,
        payeeEntityId: null,
      }));
    }
    return deriveSchedulePayments(model, contracts);
  }, [model, contracts, isDraft]);

  const groupEntityId = React.useMemo(
    () => legs.find((l) => l.payeeEntityId)?.payeeEntityId ?? null,
    [legs]
  );
  const propertyWalletId = React.useMemo(
    () => legs.find((l) => l.payeeWalletId)?.payeeWalletId ?? null,
    [legs]
  );

  // ── Property account: balance + incoming + activity ────────────────
  // The landlord (and a group-member managing agent) can read the
  // property account — its balance, the cash awaiting acceptance, and the
  // merged history — all acting as the group.
  const canViewProperty = (isLandlord || isAgent) && isLive && !!groupEntityId;
  const [balance, setBalance] = React.useState<PropertyBalance | null>(null);
  const [propertyIncoming, setPropertyIncoming] = React.useState<PropertyIncoming[]>([]);
  const [propertyActivity, setPropertyActivity] = React.useState<ActivityRow[]>([]);
  const [activityOpen, setActivityOpen] = React.useState(false);
  const reloadBalance = React.useCallback(async () => {
    if (!model || !canViewProperty || !model.denominationAssetId || !groupEntityId) {
      setBalance(null);
      setPropertyIncoming([]);
      setPropertyActivity([]);
      return;
    }
    // Balance (cash vs tenant credit) — needs a tenant to read the credit leg.
    if (model.tenantEntityId) {
      try {
        setBalance(
          await fetchPropertyBalance({
            denominationAssetId: model.denominationAssetId,
            tenantEntityId: model.tenantEntityId,
            groupEntityId,
          })
        );
      } catch {
        /* best-effort */
      }
    }
    // Cash awaiting acceptance into the property account.
    try {
      setPropertyIncoming(await fetchPropertyIncoming(groupEntityId));
    } catch {
      /* best-effort */
    }
    // Merged history feed for the property wallet.
    if (propertyWalletId) {
      try {
        setPropertyActivity(
          await fetchWalletActivity({
            walletId: propertyWalletId,
            groupEntityId,
            denomination: model.denomination,
            limit: 6,
          })
        );
      } catch {
        /* best-effort */
      }
    }
  }, [model, canViewProperty, groupEntityId, propertyWalletId]);
  React.useEffect(() => {
    void reloadBalance();
  }, [reloadBalance]);

  const [acceptingPropertyId, setAcceptingPropertyId] = React.useState<string | null>(null);
  const [propertyIncomingError, setPropertyIncomingError] = React.useState<string | null>(null);
  const acceptIncoming = async (p: PropertyIncoming) => {
    if (!groupEntityId) return;
    setPropertyIncomingError(null);
    setAcceptingPropertyId(p.id);
    try {
      await acceptPropertyIncoming({
        paymentId: p.id,
        walletId: p.walletId ?? undefined,
        groupEntityId,
      });
      await reloadBalance();
    } catch (e) {
      setPropertyIncomingError((e as Error).message);
    } finally {
      setAcceptingPropertyId(null);
    }
  };

  // ── Tenant: their OWN account (cash + incoming + activity) ─────────
  // The tenant's counterpart to the landlord's property-account view —
  // their own wallet, all under their own token (no delegation).
  const [tenantWalletId, setTenantWalletId] = React.useState<string | null>(null);
  const [tenantCash, setTenantCash] = React.useState<string | null>(null);
  const [tenantIncoming, setTenantIncoming] = React.useState<PropertyIncoming[]>([]);
  const [tenantActivity, setTenantActivity] = React.useState<ActivityRow[]>([]);
  const [tenantActivityOpen, setTenantActivityOpen] = React.useState(false);

  // Resolve the tenant's own wallet id once (for the activity feed).
  React.useEffect(() => {
    if (!isTenant) {
      setTenantWalletId(null);
      return;
    }
    let cancelled = false;
    fetchJwtInfo()
      .then((info) => {
        if (!cancelled) setTenantWalletId(info.default_wallet_id ?? null);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [isTenant]);

  const reloadTenantAccount = React.useCallback(async () => {
    if (!model || !isTenant || !isLive || !model.denominationAssetId) {
      setTenantCash(null);
      setTenantIncoming([]);
      setTenantActivity([]);
      return;
    }
    try {
      const b = await fetchBalance(model.denominationAssetId);
      setTenantCash(vaultBalanceToHuman(b.raw, b.decimals));
    } catch {
      /* best-effort */
    }
    try {
      setTenantIncoming(await fetchTenantIncoming());
    } catch {
      /* best-effort */
    }
    if (tenantWalletId) {
      try {
        setTenantActivity(
          await fetchWalletActivity({
            walletId: tenantWalletId,
            denomination: model.denomination,
            limit: 6,
          })
        );
      } catch {
        /* best-effort */
      }
    }
  }, [model, isTenant, isLive, tenantWalletId]);
  React.useEffect(() => {
    void reloadTenantAccount();
  }, [reloadTenantAccount]);

  const [acceptingTenantId, setAcceptingTenantId] = React.useState<string | null>(null);
  const [tenantIncomingError, setTenantIncomingError] = React.useState<string | null>(null);
  const acceptTenantPayment = async (p: PropertyIncoming) => {
    setTenantIncomingError(null);
    setAcceptingTenantId(p.id);
    try {
      await acceptTenantIncoming({
        paymentId: p.id,
        walletId: p.walletId ?? undefined,
        ownerEntityId: callerId,
      });
      await reloadTenantAccount();
    } catch (e) {
      setTenantIncomingError((e as Error).message);
    } finally {
      setAcceptingTenantId(null);
    }
  };

  // ── Open exchanges (tenant) ────────────────────────────────────────
  const [exchanges, setExchanges] = React.useState<OpenExchange[]>([]);
  const reloadExchanges = React.useCallback(async () => {
    if (!isTenant || !isLive) {
      setExchanges([]);
      return;
    }
    try {
      setExchanges(await fetchOpenExchanges(callerId));
    } catch {
      /* best-effort */
    }
  }, [isTenant, isLive, callerId]);
  React.useEffect(() => {
    void reloadExchanges();
  }, [reloadExchanges]);

  // ── Automation ─────────────────────────────────────────────────────
  const [autoRows, setAutoRows] = React.useState<DealAutomationStatus[]>([]);
  const reloadAutomation = React.useCallback(async () => {
    if (isDraft) {
      setAutoRows([]);
      return;
    }
    try {
      setAutoRows(await dealAutomationStatus(deal.id));
    } catch {
      /* best-effort */
    }
  }, [deal.id, isDraft]);
  React.useEffect(() => {
    void reloadAutomation();
  }, [reloadAutomation]);

  // ── Deal execution (pending party actions) ─────────────────────────
  // After activation the DMS auto-runs the steps it holds a capability
  // for; steps assigned to a party (the tenant's accept) surface here and
  // must be executed to drive the deal to completion.
  const [pendingActions, setPendingActions] = React.useState<PendingAction[]>([]);
  const [paLoading, setPaLoading] = React.useState(false);
  const reloadPendingActions = React.useCallback(async () => {
    if (isDraft) {
      setPendingActions([]);
      return;
    }
    setPaLoading(true);
    try {
      setPendingActions(await pendingActionsForDeal(deal.id));
    } catch {
      /* best-effort */
    } finally {
      setPaLoading(false);
    }
  }, [deal.id, isDraft]);
  React.useEffect(() => {
    void reloadPendingActions();
  }, [reloadPendingActions, status]);

  // The DAG takes a few seconds to reach the party-assigned step after
  // activation — poll briefly so it surfaces without a manual refresh.
  const pollPendingActions = React.useCallback(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      await reloadPendingActions();
    }
  }, [reloadPendingActions]);

  const [executingId, setExecutingId] = React.useState<string | null>(null);
  const [execError, setExecError] = React.useState<string | null>(null);
  const executeStep = async (action: PendingAction) => {
    setExecError(null);
    setExecutingId(action.id);
    try {
      const r = await completePartyAction(action.id);
      if (!r.success) throw new Error(r.message || 'step execution failed');
      await reloadPendingActions();
      onChanged(); // the deal's status may advance
      await reloadContracts(); // the rent schedule may now populate
    } catch (e) {
      setExecError((e as Error).message);
    } finally {
      setExecutingId(null);
    }
  };

  // Activate, then poll for the steps the parties now need to execute.
  const activate = async () => {
    await runLifecycle('activate', () => activateDeal(deal.id));
    void pollPendingActions();
  };

  // ── Actions ────────────────────────────────────────────────────────
  const [collectingId, setCollectingId] = React.useState<string | null>(null);
  const [collectError, setCollectError] = React.useState<string | null>(null);
  const collect = async (leg: ScheduleLegStatus) => {
    if (!model || !leg.paymentId) return;
    setCollectError(null);
    setCollectingId(leg.paymentId);
    try {
      await collectRentLeg(leg);
      await pollLegCredited(model, leg.paymentId);
      await reloadContracts();
      await reloadBalance();
    } catch (e) {
      setCollectError((e as Error).message);
    } finally {
      setCollectingId(null);
    }
  };

  const [exBusy, setExBusy] = React.useState(false);
  const [exError, setExError] = React.useState<string | null>(null);
  const exchange = async () => {
    if (!model || !balance || !model.denominationAssetId || !model.tenantEntityId || !groupEntityId) return;
    setExError(null);
    setExBusy(true);
    try {
      await exchangeCredit({
        denominationAssetId: model.denominationAssetId,
        creditRaw: balance.creditRaw,
        tenantEntityId: model.tenantEntityId,
        groupEntityId,
      });
      // The credit escrows into the swap once the MQ lands it — refresh
      // shortly so the new request appears for the tenant.
      window.setTimeout(() => {
        void reloadBalance();
      }, 5000);
    } catch (e) {
      setExError((e as Error).message);
    } finally {
      setExBusy(false);
    }
  };

  const [settlingId, setSettlingId] = React.useState<string | null>(null);
  const [settleError, setSettleError] = React.useState<string | null>(null);
  const settle = async (swapId: string) => {
    setSettleError(null);
    setSettlingId(swapId);
    try {
      const r = await settleExchange(swapId);
      // completeSwap returns at enqueue — poll the message (keyed under
      // the tenant's own entity id) so a failure surfaces here.
      if (r.messageId) await waitForMessage(callerId, r.messageId);
      await reloadExchanges();
    } catch (e) {
      setSettleError((e as Error).message);
    } finally {
      setSettlingId(null);
    }
  };

  const [armBusy, setArmBusy] = React.useState<string | null>(null);
  const [armError, setArmError] = React.useState<string | null>(null);
  const arm = async (kind: 'collect' | 'settle') => {
    if (!model) return;
    setArmError(null);
    setArmBusy(kind);
    try {
      const gen = await apiKeysService.generate({
        service_name: `rental-${kind}-${deal.id}`,
        description: `Rental auto-${kind} for ${model.propertyName}`,
      });
      await setDealAutomationKey({
        dealId: deal.id,
        apiKey: gen.api_key,
        keyId: gen.id,
        keyLabel: gen.api_key.slice(-4),
      });
      await reloadAutomation();
    } catch (e) {
      setArmError((e as Error).message);
    } finally {
      setArmBusy(null);
    }
  };
  const stop = async (kind: 'collect' | 'settle') => {
    setArmError(null);
    setArmBusy(kind);
    try {
      await revokeDealAutomationKey(deal.id);
      await reloadAutomation();
    } catch (e) {
      setArmError((e as Error).message);
    } finally {
      setArmBusy(null);
    }
  };

  if (!model) {
    return (
      <div className="card text-sm text-ink-soft">
        This deal isn&apos;t a rental (its plan has no property account + send policy).
      </div>
    );
  }

  const collectRow = autoRows.find((r) => r.entityId === model.landlordEntityId);
  const settleRow = autoRows.find((r) => r.entityId === model.tenantEntityId);
  const collectArmed = !!collectRow?.active;
  const settleArmed = !!settleRow?.active;
  const hasCredit = !!balance && /[1-9]/.test(balance.creditRaw);

  // Plan steps + a derived per-step status for the execution checklist.
  const planNodes =
    ((deal.plan as { nodes?: Array<{ step_id: string; task_name: string }> } | null)?.nodes) ?? [];
  const paByStep = new Map(pendingActions.map((pa) => [pa.stepId, pa] as const));
  const stepDot: Record<'done' | 'awaiting' | 'pending', string> = {
    done: 'bg-status-success-text',
    awaiting: 'bg-status-warning-text',
    pending: 'bg-line-strong',
  };
  const stepStateFor = (stepId: string): 'done' | 'awaiting' | 'pending' => {
    const pa = paByStep.get(stepId);
    if (pa) return pa.status === 'COMPLETED' ? 'done' : 'awaiting';
    if (status === 'COMPLETED' || status === 'ACTIVE') return 'done';
    return 'pending';
  };

  // Lifecycle stage + the caller's role-aware "what do I do next?".
  const stage = rentalStage(status);
  const role: RentalRole = isLandlord ? 'landlord' : isTenant ? 'tenant' : isAgent ? 'agent' : 'observer';
  const myPendingAction = pendingActions.some(
    (pa) => pa.assigneeEntityId === callerId && pa.status === 'PENDING'
  );
  const collectableLeg =
    isLandlord && isLive && legs.some((l) => l.state === 'due' && !!l.paymentId && !!l.payeeEntityId);
  const step = nextStep({
    role,
    status,
    myPendingAction,
    collectableLeg,
    hasCredit: isLandlord && hasCredit,
    openExchange: isTenant && exchanges.length > 0,
  });
  const stepTone =
    step.tone === 'action'
      ? 'border border-brand-200 bg-brand-50 text-ink-deep'
      : step.tone === 'waiting'
        ? 'border border-status-warning-text/30 bg-status-warning-bg text-status-warning-text'
        : 'border border-line bg-surface-alt text-ink-soft';

  return (
    <div className="space-y-5">
      {/* ── Where this lease is + what you do next ── */}
      <div className="card space-y-3">
        <LifecycleStepper stage={stage} />
        {role !== 'observer' && (
          <div className={`rounded-lg px-3 py-2.5 ${stepTone}`}>
            <div className="mini-label">You are the {ROLE_LABEL[role]} · next step</div>
            <div className="text-sm font-semibold mt-0.5">{step.title}</div>
            <p className="text-xs mt-1 leading-relaxed opacity-90">{step.detail}</p>
          </div>
        )}
      </div>

      {/* ── Header ── */}
      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-ink-deep">{model.propertyName}</h2>
              <StatusPill status={status} />
            </div>
            <p className="mt-1 text-sm text-ink-soft">
              {model.rentAmount ? `${model.rentAmount} ${model.denomination ?? ''}` : 'Rent to be set'}{' '}
              <span className="text-ink-mute">{FREQUENCY_PER_LABEL[model.frequency]}</span> ·{' '}
              {model.schedule.length} payments
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isDraft && isLandlord && (
              <button className="btn-primary !py-1.5 text-xs" disabled={!!lifeBusy} onClick={() => runLifecycle('send', () => proposeDraft(deal.id))}>
                {lifeBusy === 'send' ? 'Sending…' : 'Send for signing'}
              </button>
            )}
            {isProposed && isParty && !isLandlord && (
              <button className="btn-primary !py-1.5 text-xs" disabled={!!lifeBusy} onClick={() => runLifecycle('sign', () => signDeal(deal.id))}>
                {lifeBusy === 'sign' ? 'Signing…' : 'Sign'}
              </button>
            )}
            {(isProposed || status === 'ACCEPTED') && isLandlord && (
              <button className="btn-secondary !py-1.5 text-xs" disabled={!!lifeBusy} onClick={activate}>
                {lifeBusy === 'activate' ? 'Activating…' : 'Activate'}
              </button>
            )}
          </div>
        </div>
        <ErrorLine message={lifeError} />
      </div>

      {/* ── Parties ── */}
      <Section title="Parties" hint="from the deal roster">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          {[
            { label: 'Landlord', id: model.landlordEntityId },
            { label: 'Tenant', id: model.tenantEntityId },
            {
              label:
                model.agentEntityId === model.landlordEntityId ? 'Managing agent · self' : 'Managing agent',
              id: model.agentEntityId,
            },
          ].map((p) => (
            <div key={p.label} className="rounded-lg border border-line p-3">
              <div className="mini-label">{p.label}</div>
              <div className="mt-0.5 text-ink truncate">{entityName(p.id)}</div>
              <div className="text-[11px] text-ink-mute font-mono truncate">{p.id ?? '—'}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Deal execution (the DAG steps + party actions) ── */}
      {!isDraft && (
        <Section title="Deal execution" docHref={DOCS.dms} docLabel="DMS ↗">
          <p className="text-xs text-ink-soft mb-3">
            On activation the DMS runs the steps it holds a capability for; steps assigned to a
            party need that party to execute them. Drive the deal&apos;s tasks to completion here.
          </p>

          <ol className="space-y-1.5 mb-4">
            {planNodes.map((node) => {
              const st = stepStateFor(node.step_id);
              return (
                <li key={node.step_id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 rounded-full ${stepDot[st]}`} aria-hidden />
                  <span className="text-ink">{stepLabel(node.task_name)}</span>
                  {st === 'awaiting' && <Pill tone="warning">Awaiting</Pill>}
                  {st === 'done' && <span className="text-[11px] text-status-success-text">done</span>}
                </li>
              );
            })}
          </ol>

          <div className="flex items-center justify-between mb-2">
            <span className="mini-label">Steps awaiting a party</span>
            <button
              className="text-xs text-brand-600 hover:underline disabled:opacity-50"
              disabled={paLoading}
              onClick={() => void reloadPendingActions()}
            >
              {paLoading ? 'Checking…' : 'Refresh'}
            </button>
          </div>

          {pendingActions.length > 0 ? (
            <ul className="space-y-2">
              {pendingActions.map((pa) => {
                const mine = pa.assigneeEntityId === callerId;
                const executable = mine && pa.status === 'PENDING';
                return (
                  <li
                    key={pa.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="text-ink truncate">{stepLabel(pa.descriptorName)}</div>
                      <div className="text-[11px] text-ink-mute truncate">
                        {mine ? 'Assigned to you' : `Awaiting ${entityName(pa.assigneeEntityId)}`}
                      </div>
                    </div>
                    {executable ? (
                      <button
                        className="btn-primary !py-1 text-xs"
                        disabled={executingId === pa.id}
                        onClick={() => executeStep(pa)}
                      >
                        {executingId === pa.id ? 'Executing…' : 'Execute'}
                      </button>
                    ) : (
                      <Pill tone={pa.status === 'COMPLETED' ? 'success' : 'info'}>{pa.status}</Pill>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : status === 'COMPLETED' ? (
            <p className="text-xs text-status-success-text">
              ✓ All steps executed — the rental is fully set up.
            </p>
          ) : (
            <p className="text-xs text-ink-mute">
              {paLoading
                ? 'Checking for steps…'
                : 'No steps awaiting a party right now — the DMS is running the deal. Refresh in a few seconds.'}
            </p>
          )}
          <ErrorLine message={execError} />
        </Section>
      )}

      {/* ── Rent schedule ── */}
      <Section title="Rent schedule" docHref={DOCS.obligationLifecycle} docLabel="Obligation lifecycle ↗">
        <ul className="space-y-2">
          {model.schedule.map((leg, i) => {
            const st = legs[i]?.state ?? 'scheduled';
            const handle = legs[i];
            const collectable =
              isLive && isLandlord && st === 'due' && !!handle?.paymentId && !!handle?.payeeEntityId;
            const collecting = collectingId && handle?.paymentId === collectingId;
            return (
              <li
                key={leg.index}
                className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="h-6 w-6 shrink-0 grid place-items-center rounded-full bg-surface-alt text-[11px] font-semibold text-ink-soft">
                    {leg.index}
                  </span>
                  <div className="min-w-0">
                    <div className="text-ink">
                      {leg.amount ?? '—'} {model.denomination ?? ''}
                    </div>
                    <div className="text-[11px] text-ink-mute">due {leg.dueDate ?? '—'}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {collecting ? (
                    <Pill tone="info">Collecting…</Pill>
                  ) : collectArmed && st === 'due' ? (
                    <Pill tone="info">Auto-collecting</Pill>
                  ) : (
                    <PaymentStateBadge state={st} />
                  )}
                  {collectable && !collecting && !collectArmed && (
                    <button
                      className="btn-secondary !py-1 text-xs"
                      onClick={() => handle && collect(handle)}
                    >
                      Collect
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <ErrorLine message={collectError} />
        <p className="mt-3 text-[11px] text-ink-mute leading-relaxed">
          Each leg unlocks on its due date and is collected into the property account as tenant
          <em> credit</em> — instantly due. The credit is then exchanged with the tenant and
          settled for cash. &quot;Credited&quot; ≠ &quot;paid&quot;.
        </p>
      </Section>

      {/* ── Property account balance (landlord or managing agent) ── */}
      {canViewProperty && (
        <Section title="Property account balance" docHref={DOCS.paymentLifecycle} docLabel="Payment lifecycle ↗">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-line p-3">
              <div className="mini-label">Cash</div>
              <div className="mt-0.5 text-ink text-lg">
                {balance ? `${balance.cash} ${model.denomination ?? ''}` : '…'}
              </div>
              <div className="text-[11px] text-ink-mute">liquid, ready to disburse</div>
            </div>
            <div className="rounded-lg border border-line p-3">
              <div className="mini-label">Credit (due from tenant)</div>
              <div className="mt-0.5 text-ink text-lg">
                {balance ? `${balance.credit} ${model.denomination ?? ''}` : '…'}
              </div>
              <div className="text-[11px] text-ink-mute">collected rent, awaiting settlement</div>
            </div>
          </div>

          {/* Exchange the collected credit for cash (landlord only). */}
          {isLandlord && (
            <div className="mt-3 flex items-center gap-2">
              <button className="btn-primary !py-1.5 text-xs" disabled={exBusy || !hasCredit} onClick={exchange}>
                {exBusy ? 'Requesting…' : 'Exchange credit → cash'}
              </button>
              <span className="text-[11px] text-ink-mute">Creates a swap the tenant settles for cash.</span>
            </div>
          )}
          <ErrorLine message={exError} />

          {/* Cash awaiting acceptance into the property account. */}
          {propertyIncoming.length > 0 && (
            <ul className="mt-3 divide-y divide-line-soft border-t border-line-soft">
              {propertyIncoming.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-ink-soft">
                    Incoming payment{p.from ? ` from ${p.from}` : ''}
                    {p.amount ? ` — ${p.amount} ${p.currency ?? model.denomination ?? ''}` : ''}
                  </span>
                  <button
                    className="btn-secondary !py-1 text-xs"
                    disabled={acceptingPropertyId !== null}
                    title="Claim this payment into the property account's cash balance"
                    onClick={() => acceptIncoming(p)}
                  >
                    {acceptingPropertyId === p.id ? 'Accepting…' : 'Accept'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ErrorLine message={propertyIncomingError} />

          {/* Recent activity — the property account's merged history feed. */}
          {propertyActivity.length > 0 && (
            <div className="mt-3 border-t border-line-soft pt-2.5">
              <button
                type="button"
                onClick={() => setActivityOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left"
                title={activityOpen ? 'Hide activity' : 'Show activity'}
              >
                <span className="mini-label">Recent activity ({propertyActivity.length})</span>
                <span
                  aria-hidden
                  className={`text-ink-mute text-xs transition-transform duration-200 ${
                    activityOpen ? 'rotate-180' : ''
                  }`}
                >
                  ▾
                </span>
              </button>
              {activityOpen && (
                <ul className="mt-1 divide-y divide-line-soft">
                  {propertyActivity.map((a) => (
                    <li
                      key={a.key}
                      className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12px]"
                    >
                      <span className={a.failed ? 'text-status-error-text' : 'text-ink-soft'}>
                        {a.label}
                        {a.failed ? ' — failed' : a.pending ? ' — in progress' : ''}
                      </span>
                      <span className="text-[11px] text-ink-mute">{a.when ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>
      )}

      {/* ── Agent send policy (landlord + managing agent) ── */}
      {(isLandlord || isAgent) && isLive && (
        <PolicySection
          model={model}
          callerId={callerId}
          isLandlord={isLandlord}
          isAgent={isAgent}
          groupEntityId={groupEntityId}
          propertyWalletId={propertyWalletId}
          entities={entities}
        />
      )}

      {/* ── Your account (tenant — their own wallet) ── */}
      {isTenant && isLive && (
        <Section title="Your account" docHref={DOCS.paymentLifecycle} docLabel="Payment lifecycle ↗">
          <div className="flex items-stretch justify-between gap-3">
            <div className="rounded-lg border border-line p-3 flex-1">
              <div className="mini-label">Cash available</div>
              <div className="mt-0.5 text-ink text-lg">
                {tenantCash !== null ? `${tenantCash} ${model.denomination ?? ''}` : '…'}
              </div>
              <div className="text-[11px] text-ink-mute">your liquid balance — used to settle rent</div>
            </div>
            <Link to="/wallet" className="btn-secondary !py-1.5 text-xs whitespace-nowrap self-start">
              Open wallet →
            </Link>
          </div>

          {/* Money sent to you, awaiting your acceptance. */}
          {tenantIncoming.length > 0 && (
            <ul className="mt-3 divide-y divide-line-soft border-t border-line-soft">
              {tenantIncoming.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-ink-soft">
                    Incoming payment{p.from ? ` from ${p.from}` : ''}
                    {p.amount ? ` — ${p.amount} ${p.currency ?? model.denomination ?? ''}` : ''}
                  </span>
                  <button
                    className="btn-secondary !py-1 text-xs"
                    disabled={acceptingTenantId !== null}
                    title="Claim this payment into your cash balance"
                    onClick={() => acceptTenantPayment(p)}
                  >
                    {acceptingTenantId === p.id ? 'Accepting…' : 'Accept'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ErrorLine message={tenantIncomingError} />

          {/* Recent activity — your wallet's merged history feed. */}
          {tenantActivity.length > 0 && (
            <div className="mt-3 border-t border-line-soft pt-2.5">
              <button
                type="button"
                onClick={() => setTenantActivityOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left"
                title={tenantActivityOpen ? 'Hide activity' : 'Show activity'}
              >
                <span className="mini-label">Recent activity ({tenantActivity.length})</span>
                <span
                  aria-hidden
                  className={`text-ink-mute text-xs transition-transform duration-200 ${
                    tenantActivityOpen ? 'rotate-180' : ''
                  }`}
                >
                  ▾
                </span>
              </button>
              {tenantActivityOpen && (
                <ul className="mt-1 divide-y divide-line-soft">
                  {tenantActivity.map((a) => (
                    <li
                      key={a.key}
                      className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12px]"
                    >
                      <span className={a.failed ? 'text-status-error-text' : 'text-ink-soft'}>
                        {a.label}
                        {a.failed ? ' — failed' : a.pending ? ' — in progress' : ''}
                      </span>
                      <span className="text-[11px] text-ink-mute">{a.when ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>
      )}

      {/* ── Settle (tenant) ── */}
      {isTenant && isLive && (
        <Section title="Rent settlements" docHref={DOCS.paymentLifecycle} docLabel="Payment lifecycle ↗">
          {exchanges.length === 0 ? (
            <p className="text-xs text-ink-mute">
              No open settlements. When the landlord collects rent and exchanges the credit, the
              cash settlement appears here.
            </p>
          ) : (
            <ul className="space-y-2">
              {exchanges.map((swap) => {
                const amount = swap.payments?.[0]?.amount;
                return (
                  <li
                    key={swap.swapId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="text-ink">
                        Settle {amount ? `${amount} ${model.denomination ?? ''}` : ''}
                      </div>
                      <div className="text-[11px] text-ink-mute font-mono truncate">{swap.swapId}</div>
                    </div>
                    {settleArmed ? (
                      <Pill tone="info">Auto-settling</Pill>
                    ) : (
                      <button
                        className="btn-primary !py-1 text-xs"
                        disabled={settlingId === swap.swapId}
                        onClick={() => settle(swap.swapId)}
                      >
                        {settlingId === swap.swapId ? 'Settling…' : 'Settle & pay'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <ErrorLine message={settleError} />
        </Section>
      )}

      {/* ── Automation ── */}
      {isLive && (isLandlord || isTenant) && (
        <Section title="Automation" docHref={DOCS.dms} docLabel="DMS ↗">
          <p className="text-xs text-ink-soft mb-3">
            Arming stores a scoped <code className="bg-surface-alt px-1 rounded">yf_api_…</code>{' '}
            credential the rent worker fires under, so your side of the loop runs unattended
            (checks {formatCadence(model.cadenceSeconds)}).
          </p>
          <div className="space-y-3">
            {isLandlord && (
              <ArmRow
                label="Auto-collect (landlord)"
                armed={collectArmed}
                busy={armBusy === 'collect'}
                onArm={() => arm('collect')}
                onStop={() => stop('collect')}
              />
            )}
            {isTenant && (
              <ArmRow
                label="Auto-settle (tenant)"
                armed={settleArmed}
                busy={armBusy === 'settle'}
                onArm={() => arm('settle')}
                onStop={() => stop('settle')}
              />
            )}
          </div>
          <ErrorLine message={armError} />
        </Section>
      )}

      {/* ── The plan (transparency) ── */}
      <details className="card">
        <summary className="text-sm font-semibold text-ink-deep cursor-pointer">
          DealPlan <span className="mini-label ml-1">the compiled artifact</span>
        </summary>
        <pre className="mt-3 text-[11px] leading-relaxed bg-surface-alt rounded-lg p-3 overflow-auto max-h-[28rem] text-ink">
          {JSON.stringify(deal.plan, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function ArmRow({
  label,
  armed,
  busy,
  onArm,
  onStop,
}: {
  label: string;
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-ink">{label}</span>
        <Pill tone={armed ? 'success' : 'neutral'}>{armed ? 'Armed' : 'Not armed'}</Pill>
      </div>
      {armed ? (
        <button className="btn-secondary !py-1 text-xs" disabled={busy} onClick={onStop}>
          {busy ? 'Stopping…' : 'Stop'}
        </button>
      ) : (
        <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={onArm}>
          {busy ? 'Arming…' : 'Arm'}
        </button>
      )}
    </div>
  );
}
