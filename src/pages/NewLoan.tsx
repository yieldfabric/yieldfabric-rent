import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@yieldfabric/wallet';

import DocLink from '../components/DocLink';
import { DOCS } from '../docs';
import { useAssets } from '../lib/useAssets';
import { fetchEntities, type EntityOption } from '../lib/payments';
import { saveDealDraft } from '../lib/dealFlow';
import {
  buildLoanDraft,
  monthlyPayment,
  amortize,
  fmtMoney,
  type NewLoanParams,
} from '../lib/loanModel';
import { firstOfNextMonthIso, localInputToInstant, DEFAULT_CADENCE_SECONDS } from '../lib/rentalModel';

/**
 * Compose a loan — the loan analog of NewLease. Collects the loan terms,
 * builds the periodic loan `DealPlan` (`buildLoanDraft`), and saves it as a
 * draft. Unlike a rental, the plan carries `cashflow_ref: amortizing_loan`
 * + `deal_terms` + a per-period sub-DAG, so the platform amortizes each
 * repayment. The preview shows both the plan and the amortization.
 */

type Phase = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string };

export default function NewLoan() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { assets } = useAssets();
  const [entities, setEntities] = React.useState<EntityOption[]>([]);
  const [entitiesError, setEntitiesError] = React.useState<string | null>(null);

  const [loanName, setLoanName] = React.useState('Term loan — Acme Pty');
  const [borrowerEntityId, setBorrowerEntityId] = React.useState('');
  const [denomination, setDenomination] = React.useState('');
  const [principal, setPrincipal] = React.useState('100000');
  const [interestPct, setInterestPct] = React.useState('8');
  const [termMonths, setTermMonths] = React.useState(24);
  const [startDate, setStartDate] = React.useState(firstOfNextMonthIso());
  const [refinanceable, setRefinanceable] = React.useState(true);
  const [cadenceSeconds, setCadenceSeconds] = React.useState(DEFAULT_CADENCE_SECONDS);

  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });
  const lenderEntityId = user?.id ?? '';

  React.useEffect(() => {
    fetchEntities().then(setEntities).catch((e: Error) => setEntitiesError(e.message));
  }, []);
  React.useEffect(() => {
    if (!denomination && assets.length > 0) setDenomination(assets[0].id);
  }, [assets, denomination]);

  const params: NewLoanParams = React.useMemo(
    () => ({
      loanName,
      lenderEntityId,
      borrowerEntityId,
      principal,
      interestPct,
      termMonths,
      startDate,
      denomination: denomination || undefined,
      refinanceable,
      cadenceSeconds,
    }),
    [loanName, lenderEntityId, borrowerEntityId, principal, interestPct, termMonths, startDate, denomination, refinanceable, cadenceSeconds]
  );

  const draftPreview = React.useMemo(() => {
    try {
      return buildLoanDraft(params);
    } catch {
      return null;
    }
  }, [params]);

  // Amortization preview (client-side; the platform's engine is authoritative).
  const amort = React.useMemo(() => {
    const p = Number(principal.replace(/,/g, '')) || 0;
    const r = Number(interestPct.replace(/,/g, '')) || 0;
    const n = Math.max(1, Math.floor(termMonths));
    const rows = amortize(p, r, n, localInputToInstant(startDate).toISOString());
    const pay = monthlyPayment(p, r, n);
    const totalRepaid = rows.reduce((s, x) => s + x.payment, 0);
    return { rows, pay, totalRepaid, totalInterest: Math.max(0, totalRepaid - p) };
  }, [principal, interestPct, termMonths, startDate]);

  const working = phase.kind === 'working';
  const tenantOptions = entities.filter((e) => e.id !== lenderEntityId);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!borrowerEntityId) {
      setPhase({ kind: 'error', message: 'Pick a borrower.' });
      return;
    }
    setPhase({ kind: 'working' });
    try {
      const draft = buildLoanDraft(params);
      const deal = await saveDealDraft({ name: draft.name, parties: draft.parties, plan: draft.plan });
      navigate(`/loans?id=${encodeURIComponent(deal.id)}`);
    } catch (err) {
      setPhase({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <span className="mini-label">dealFlow.saveDealDraft · periodic deal</span>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-deep mt-1">New loan</h1>
        <p className="mt-2 text-sm text-ink-soft max-w-2xl">
          Define the loan terms; the app builds a periodic{' '}
          <DocLink href={DOCS.loans} title="Loans — periodic / amortizing deals">
            DMS deal plan
          </DocLink>{' '}
          with an <code className="bg-surface-alt px-1 rounded">amortizing_loan</code> cashflow and
          saves it as a draft. You&apos;ll sign + activate it on the{' '}
          <Link to="/loans" className="text-brand-600 hover:underline">
            Loans
          </Link>{' '}
          page (activation disburses the principal).
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
        {/* ── Terms ── */}
        <form onSubmit={create} className="card space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-deep">Loan terms</h2>
            <span className="mini-label">periodic plan + cashflow</span>
          </div>

          {entitiesError && (
            <p className="text-xs text-status-error-text">Couldn&apos;t load entities: {entitiesError}</p>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">Loan name</span>
            <input className="field" value={loanName} onChange={(e) => setLoanName(e.target.value)} required />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">Borrower</span>
            <select className="field" value={borrowerEntityId} onChange={(e) => setBorrowerEntityId(e.target.value)} required>
              <option value="">Select a borrower…</option>
              {tenantOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.id.slice(0, 10)}…)
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-ink-mute">
              The borrower owes the repayments — an entity, never a 0x… address.
            </span>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">Denomination</span>
            <select className="field" value={denomination} onChange={(e) => setDenomination(e.target.value)}>
              {assets.length === 0 && <option value="aud-token-asset">aud-token-asset</option>}
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || a.currency || a.id} ({a.id})
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-3 gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-ink-soft mb-1">Principal</span>
              <input className="field" type="number" min="0" value={principal} onChange={(e) => setPrincipal(e.target.value)} required />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-soft mb-1">Rate % p.a.</span>
              <input className="field" type="number" min="0" step="0.01" value={interestPct} onChange={(e) => setInterestPct(e.target.value)} required />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-soft mb-1">Term (months)</span>
              <input className="field" type="number" min="1" max="120" value={termMonths} onChange={(e) => setTermMonths(Number(e.target.value))} required />
            </label>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">First repayment due</span>
            <input className="field" type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>

          <label className="flex items-center gap-2 text-xs font-medium text-ink-soft">
            <input type="checkbox" checked={refinanceable} onChange={(e) => setRefinanceable(e.target.checked)} />
            Sellable loan — mint the note into a transferable class
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">Automation check interval (seconds)</span>
            <input className="field" type="number" min="0" value={cadenceSeconds} onChange={(e) => setCadenceSeconds(Number(e.target.value))} />
            <span className="mt-1 block text-[11px] text-ink-mute">
              How often the period scheduler checks this loan once the borrower arms auto-pay. 0 ⇒
              worker default.
            </span>
          </label>

          {phase.kind === 'error' && (
            <div className="rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">{phase.message}</div>
          )}

          <button type="submit" className="btn-primary w-full" disabled={working}>
            {working ? 'Saving draft…' : 'Create loan draft'}
          </button>
        </form>

        {/* ── Previews ── */}
        <div className="space-y-6">
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink-deep">Amortization</h2>
              <span className="mini-label">computed from principal · rate · term</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm mb-3">
              <div className="rounded-lg border border-line p-2.5">
                <div className="mini-label">Monthly payment</div>
                <div className="mt-0.5 text-ink">{fmtMoney(amort.pay)}</div>
              </div>
              <div className="rounded-lg border border-line p-2.5">
                <div className="mini-label">Total interest</div>
                <div className="mt-0.5 text-ink">{fmtMoney(amort.totalInterest)}</div>
              </div>
              <div className="rounded-lg border border-line p-2.5">
                <div className="mini-label">Total repaid</div>
                <div className="mt-0.5 text-ink">{fmtMoney(amort.totalRepaid)}</div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left border-b border-line">
                    <th className="mini-label pb-1 pr-3">#</th>
                    <th className="mini-label pb-1 pr-3">Payment</th>
                    <th className="mini-label pb-1 pr-3">Interest</th>
                    <th className="mini-label pb-1 pr-3">Principal</th>
                    <th className="mini-label pb-1">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {amort.rows.slice(0, 4).map((r) => (
                    <tr key={r.index} className="border-b border-line-soft last:border-0">
                      <td className="py-1 pr-3 text-ink-mute">{r.index}</td>
                      <td className="py-1 pr-3 text-ink">{fmtMoney(r.payment)}</td>
                      <td className="py-1 pr-3 text-ink-soft">{fmtMoney(r.interest)}</td>
                      <td className="py-1 pr-3 text-ink-soft">{fmtMoney(r.principal)}</td>
                      <td className="py-1 text-ink-soft">{fmtMoney(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {amort.rows.length > 4 && (
                <p className="mt-1 text-[10px] text-ink-mute">+ {amort.rows.length - 4} more periods</p>
              )}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink-deep">DealPlan preview</h2>
              <span className="mini-label">periodic · amortizing_loan</span>
            </div>
            <p className="text-xs text-ink-soft mb-3">
              Note <code className="bg-surface-alt px-1 rounded">cashflow_ref</code>,{' '}
              <code className="bg-surface-alt px-1 rounded">deal_terms</code>, and the per-period{' '}
              <code className="bg-surface-alt px-1 rounded">periodic_template</code> — the engine that
              splits each repayment into interest + principal.
            </p>
            <pre className="text-[11px] leading-relaxed bg-surface-alt rounded-lg p-3 overflow-auto max-h-[28rem] text-ink">
              {draftPreview ? JSON.stringify(draftPreview, null, 2) : '// fill in the terms to preview the plan'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
