import React from 'react';
import { apiKeysService } from '@yieldfabric/wallet';

import DocLink from './DocLink';
import LifecycleStepper from './LifecycleStepper';
import { Pill, StatusPill } from './badges';
import { DOCS } from '../docs';
import { rentalStage } from '../lib/lifecycle';
import { loanNextStep, LOAN_ROLE_LABEL, type LoanRole } from '../lib/loanLifecycle';
import {
  proposeDraft,
  signDeal,
  activateDeal,
  pendingActionsForDeal,
  completePartyAction,
  dealAutomationStatus,
  setDealAutomationKey,
  revokeDealAutomationKey,
  dealPeriods,
  processDealPeriod,
} from '../lib/dealFlow';
import type { Deal, DealAutomationStatus, DealPeriodView, PendingAction } from '../lib/dealTypes';
import { parseLoan, fmtMoney } from '../lib/loanModel';
import type { EntityOption } from '../lib/payments';

/**
 * The loan detail — the loan analog of LeaseDetail. Same lifecycle spine
 * (stepper + role-aware next step + Send/Sign/Activate + deal execution),
 * with loan-specific sections: the amortization + live repayment schedule
 * (per-period interest/principal split + `processDealPeriod`), borrower
 * auto-pay, and a note on the transferable (sellable) loan note.
 */

const TASK_LABELS: Record<string, string> = {
  deploy_contract: 'Deploy the loan-note class',
  create_composed_contract: 'Mint the loan note',
  instant_send: 'Disburse the principal',
  accept_obligation: 'Borrower accepts the loan',
};
function humanizeStep(name: string): string {
  return name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
function stepLabel(name: string): string {
  return TASK_LABELS[name] ?? humanizeStep(name);
}

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
        {docHref ? (
          <DocLink href={docHref} className="text-[11px] text-brand-600 hover:underline">
            {docLabel ?? 'docs'}
          </DocLink>
        ) : (
          hint && <span className="mini-label">{hint}</span>
        )}
      </div>
      {children}
    </section>
  );
}
function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="mt-2 rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">{message}</div>;
}

const PERIOD_TONE: Record<string, 'success' | 'info' | 'warning' | 'error' | 'neutral'> = {
  COMPLETED: 'success',
  PROCESSING: 'info',
  SCHEDULED: 'warning',
  FAILED: 'error',
};

export default function LoanDetail({
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
  const model = React.useMemo(() => parseLoan(deal), [deal]);
  const entityName = React.useCallback(
    (id: string | null | undefined) => (!id ? '—' : entities.find((e) => e.id === id)?.name ?? `${id.slice(0, 12)}…`),
    [entities]
  );

  const status = deal.status;
  const isDraft = status === 'DRAFT';
  const isProposed = status === 'PROPOSED';
  const isLive = status === 'ACTIVE' || status === 'COMPLETED';
  const isLender = !!model && callerId === model.lenderEntityId;
  const isBorrower = !!model?.borrowerEntityId && callerId === model.borrowerEntityId;
  const isParty = deal.parties.some((p) => p.entityId === callerId);

  // ── Lifecycle ──────────────────────────────────────────────────────
  const [lifeBusy, setLifeBusy] = React.useState<string | null>(null);
  const [lifeError, setLifeError] = React.useState<string | null>(null);
  const runLifecycle = async (kind: string, fn: () => Promise<{ success?: boolean; message?: string | null } | unknown>) => {
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

  // ── Deal execution (pending party actions) ─────────────────────────
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
      onChanged();
    } catch (e) {
      setExecError((e as Error).message);
    } finally {
      setExecutingId(null);
    }
  };

  // ── Repayment periods (the periodic ledger) ────────────────────────
  const [periods, setPeriods] = React.useState<DealPeriodView[]>([]);
  const reloadPeriods = React.useCallback(async () => {
    if (isDraft) {
      setPeriods([]);
      return;
    }
    try {
      setPeriods(await dealPeriods(deal.id));
    } catch {
      /* best-effort */
    }
  }, [deal.id, isDraft]);
  React.useEffect(() => {
    void reloadPeriods();
  }, [reloadPeriods, status]);

  // ── Automation (borrower auto-pay) ─────────────────────────────────
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

  const activate = async () => {
    await runLifecycle('activate', () => activateDeal(deal.id));
    void pollPendingActions();
    void reloadPeriods();
  };

  // ── Repay a period ─────────────────────────────────────────────────
  const periodsByIdx = React.useMemo(
    () => new Map(periods.map((p) => [p.periodIndex, p] as const)),
    [periods]
  );
  const nextRepayIdx = React.useMemo(() => {
    const pending = periods
      .filter((p) => p.status !== 'COMPLETED')
      .sort((a, b) => a.periodIndex - b.periodIndex)[0];
    return pending ? pending.periodIndex : periods.length === 0 ? 0 : null;
  }, [periods]);
  const [repayBusy, setRepayBusy] = React.useState(false);
  const [repayError, setRepayError] = React.useState<string | null>(null);
  const repay = async () => {
    if (nextRepayIdx == null) return;
    setRepayError(null);
    setRepayBusy(true);
    try {
      const r = await processDealPeriod(deal.id, nextRepayIdx);
      if (!r.success && r.status === 'FAILED') throw new Error(r.message || 'repayment failed');
      // The scheduler advances the row asynchronously — refresh a couple of times.
      await reloadPeriods();
      window.setTimeout(() => void reloadPeriods(), 4000);
    } catch (e) {
      setRepayError((e as Error).message);
    } finally {
      setRepayBusy(false);
    }
  };

  // ── Borrower auto-pay arm/stop ─────────────────────────────────────
  const [armBusy, setArmBusy] = React.useState(false);
  const [armError, setArmError] = React.useState<string | null>(null);
  const arm = async () => {
    if (!model) return;
    setArmError(null);
    setArmBusy(true);
    try {
      const gen = await apiKeysService.generate({
        service_name: `loan-pay-${deal.id}`,
        description: `Auto-pay for ${model.loanName}`,
      });
      await setDealAutomationKey({ dealId: deal.id, apiKey: gen.api_key, keyId: gen.id, keyLabel: gen.api_key.slice(-4) });
      await reloadAutomation();
    } catch (e) {
      setArmError((e as Error).message);
    } finally {
      setArmBusy(false);
    }
  };
  const stop = async () => {
    setArmError(null);
    setArmBusy(true);
    try {
      await revokeDealAutomationKey(deal.id);
      await reloadAutomation();
    } catch (e) {
      setArmError((e as Error).message);
    } finally {
      setArmBusy(false);
    }
  };

  if (!model) {
    return <div className="card text-sm text-ink-soft">This deal isn&apos;t a loan.</div>;
  }

  // ── Derived ────────────────────────────────────────────────────────
  const stage = rentalStage(status);
  const role: LoanRole = isLender ? 'lender' : isBorrower ? 'borrower' : 'observer';
  const myPendingAction = pendingActions.some((pa) => pa.assigneeEntityId === callerId && pa.status === 'PENDING');
  const borrowerAuto = autoRows.find((r) => r.entityId === model.borrowerEntityId);
  const autoPayArmed = !!borrowerAuto?.active;
  const duePeriod = periods.some((p) => p.status === 'SCHEDULED');
  const step = loanNextStep({ role, status, myPendingAction, duePeriod, autoPayArmed });
  const stepTone =
    step.tone === 'action'
      ? 'border border-brand-200 bg-brand-50 text-ink-deep'
      : step.tone === 'waiting'
        ? 'border border-status-warning-text/30 bg-status-warning-bg text-status-warning-text'
        : 'border border-line bg-surface-alt text-ink-soft';

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

  return (
    <div className="space-y-5">
      {/* ── Where this loan is + next step ── */}
      <div className="card space-y-3">
        <LifecycleStepper stage={stage} />
        {role !== 'observer' && (
          <div className={`rounded-lg px-3 py-2.5 ${stepTone}`}>
            <div className="mini-label">You are the {LOAN_ROLE_LABEL[role]} · next step</div>
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
              <h2 className="text-lg font-semibold text-ink-deep">{model.loanName}</h2>
              <StatusPill status={status} />
            </div>
            <p className="mt-1 text-sm text-ink-soft">
              {model.principal != null ? `${fmtMoney(model.principal)} ${model.denomination ?? ''}` : 'Principal to be set'}
              {model.interestPct != null ? ` · ${model.interestPct}% p.a.` : ''} · {model.termPeriods} periods
              {model.transferable && <span className="ml-2 text-[11px] text-ink-mute">· sellable note</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isDraft && isLender && (
              <button className="btn-primary !py-1.5 text-xs" disabled={!!lifeBusy} onClick={() => runLifecycle('send', () => proposeDraft(deal.id))}>
                {lifeBusy === 'send' ? 'Sending…' : 'Send for signing'}
              </button>
            )}
            {isProposed && isParty && !isLender && (
              <button className="btn-primary !py-1.5 text-xs" disabled={!!lifeBusy} onClick={() => runLifecycle('sign', () => signDeal(deal.id))}>
                {lifeBusy === 'sign' ? 'Signing…' : 'Sign'}
              </button>
            )}
            {(isProposed || status === 'ACCEPTED') && isLender && (
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {[
            { label: 'Lender', id: model.lenderEntityId },
            { label: 'Borrower', id: model.borrowerEntityId },
          ].map((p) => (
            <div key={p.label} className="rounded-lg border border-line p-3">
              <div className="mini-label">{p.label}</div>
              <div className="mt-0.5 text-ink truncate">{entityName(p.id)}</div>
              <div className="text-[11px] text-ink-mute font-mono truncate">{p.id ?? '—'}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Deal execution ── */}
      {!isDraft && (
        <Section title="Deal execution" docHref={DOCS.dms} docLabel="DMS ↗">
          <p className="text-xs text-ink-soft mb-3">
            On activation the DMS deploys the note, mints the loan, disburses the principal, and the
            borrower accepts. Steps assigned to a party are executed here.
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
            <button className="text-xs text-brand-600 hover:underline disabled:opacity-50" disabled={paLoading} onClick={() => void reloadPendingActions()}>
              {paLoading ? 'Checking…' : 'Refresh'}
            </button>
          </div>
          {pendingActions.length > 0 ? (
            <ul className="space-y-2">
              {pendingActions.map((pa) => {
                const mine = pa.assigneeEntityId === callerId;
                const executable = mine && pa.status === 'PENDING';
                return (
                  <li key={pa.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="text-ink truncate">{stepLabel(pa.descriptorName)}</div>
                      <div className="text-[11px] text-ink-mute truncate">
                        {mine ? 'Assigned to you' : `Awaiting ${entityName(pa.assigneeEntityId)}`}
                      </div>
                    </div>
                    {executable ? (
                      <button className="btn-primary !py-1 text-xs" disabled={executingId === pa.id} onClick={() => executeStep(pa)}>
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
            <p className="text-xs text-status-success-text">✓ All steps executed.</p>
          ) : (
            <p className="text-xs text-ink-mute">
              {paLoading ? 'Checking…' : 'No steps awaiting a party right now — the DMS is running the deal. Refresh in a few seconds.'}
            </p>
          )}
          <ErrorLine message={execError} />
        </Section>
      )}

      {/* ── Repayment schedule (amortization + live periods) ── */}
      <Section title="Repayment schedule" docHref={DOCS.dms} docLabel="DMS ↗">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-ink-soft">
            Each repayment splits into interest (on the balance) + principal — computed by the{' '}
            <code className="bg-surface-alt px-1 rounded">amortizing_loan</code> engine.
          </span>
          <div className="flex items-center gap-3">
            {!isDraft && (
              <button className="text-xs text-brand-600 hover:underline" onClick={() => void reloadPeriods()}>
                Refresh
              </button>
            )}
            {isBorrower && isLive && !autoPayArmed && nextRepayIdx != null && (
              <button className="btn-primary !py-1 text-xs" disabled={repayBusy} onClick={repay}>
                {repayBusy ? 'Repaying…' : `Repay period ${nextRepayIdx + 1}`}
              </button>
            )}
            {isBorrower && isLive && autoPayArmed && <Pill tone="info">Auto-paying</Pill>}
          </div>
        </div>
        <ErrorLine message={repayError} />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="mini-label pb-2 pr-3">#</th>
                <th className="mini-label pb-2 pr-3">Due</th>
                <th className="mini-label pb-2 pr-3">Payment</th>
                <th className="mini-label pb-2 pr-3">Interest</th>
                <th className="mini-label pb-2 pr-3">Principal</th>
                <th className="mini-label pb-2 pr-3">Balance</th>
                <th className="mini-label pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {model.schedule.map((r) => {
                const period = periodsByIdx.get(r.index - 1);
                return (
                  <tr key={r.index} className="border-b border-line-soft last:border-0">
                    <td className="py-1.5 pr-3 text-ink-mute">{r.index}</td>
                    <td className="py-1.5 pr-3 text-ink-soft whitespace-nowrap">{r.dueDate ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-ink">{fmtMoney(r.payment)}</td>
                    <td className="py-1.5 pr-3 text-ink-soft">{fmtMoney(r.interest)}</td>
                    <td className="py-1.5 pr-3 text-ink-soft">{fmtMoney(r.principal)}</td>
                    <td className="py-1.5 pr-3 text-ink-soft">{fmtMoney(r.balance)}</td>
                    <td className="py-1.5">
                      {period ? (
                        <Pill tone={PERIOD_TONE[period.status] ?? 'neutral'}>{period.status}</Pill>
                      ) : (
                        <span className="text-ink-mute">{isLive ? '—' : 'projected'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── Automation (borrower auto-pay) ── */}
      {isBorrower && isLive && (
        <Section title="Automation" docHref={DOCS.dms} docLabel="DMS ↗">
          <p className="text-xs text-ink-soft mb-3">
            Arm auto-pay and the period scheduler fires each repayment for you under a scoped{' '}
            <code className="bg-surface-alt px-1 rounded">yf_api_…</code> credential.
          </p>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink">Auto-pay repayments</span>
              <Pill tone={autoPayArmed ? 'success' : 'neutral'}>{autoPayArmed ? 'Armed' : 'Not armed'}</Pill>
            </div>
            {autoPayArmed ? (
              <button className="btn-secondary !py-1 text-xs" disabled={armBusy} onClick={stop}>
                {armBusy ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button className="btn-primary !py-1 text-xs" disabled={armBusy} onClick={arm}>
                {armBusy ? 'Arming…' : 'Arm'}
              </button>
            )}
          </div>
          <ErrorLine message={armError} />
        </Section>
      )}

      {/* ── Sellable note ── */}
      {model.transferable && (
        <Section title="The loan note" hint="transferable">
          <p className="text-xs text-ink-soft leading-relaxed">
            This loan was minted into a <strong className="text-ink">transferable</strong> note class —
            the note NFT is the creditor position, so the loan can be <em>sold</em> by transferring
            it. In the production serviced model the platform re-routes future collection to the
            buyer automatically (it resolves the note&apos;s owner live on each collect). This sample
            uses direct repayment to the original lender; selling the loan end-to-end is covered in
            the README&apos;s &ldquo;going further&rdquo;.
          </p>
        </Section>
      )}

      {/* ── The plan ── */}
      <details className="card">
        <summary className="text-sm font-semibold text-ink-deep cursor-pointer">
          DealPlan <span className="mini-label ml-1">periodic · amortizing_loan</span>
        </summary>
        <pre className="mt-3 text-[11px] leading-relaxed bg-surface-alt rounded-lg p-3 overflow-auto max-h-[28rem] text-ink">
          {JSON.stringify(deal.plan, null, 2)}
        </pre>
      </details>
    </div>
  );
}
