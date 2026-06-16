import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '@yieldfabric/wallet';

import { StatusPill } from '../components/badges';
import LoanDetail from '../components/LoanDetail';
import { DOCS } from '../docs';
import DocLink from '../components/DocLink';
import { listMyDeals } from '../lib/dealFlow';
import { fetchEntities, type EntityOption } from '../lib/payments';
import { isLoanDeal, parseLoan, fmtMoney } from '../lib/loanModel';
import type { Deal } from '../lib/dealTypes';

/**
 * Loans — list + detail, mirroring Leases. Every loan you're a party to
 * (`dealFlow.dealsByParty`, filtered to loans by `isLoanDeal`), projected
 * with `parseLoan` and rendered with `<LoanDetail>`.
 */
export default function Loans() {
  const { user } = useAuth();
  const callerId = user?.id ?? '';
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id');

  const [deals, setDeals] = React.useState<Deal[]>([]);
  const [entities, setEntities] = React.useState<EntityOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      const [all, ents] = await Promise.all([listMyDeals(), fetchEntities()]);
      setDeals(all.filter((d) => isLoanDeal(d)));
      setEntities(ents);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void reload();
  }, [reload]);

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('id', id);
    setParams(next, { replace: true });
  };
  const selected = React.useMemo(() => deals.find((d) => d.id === selectedId) ?? null, [deals, selectedId]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <span className="mini-label">dealFlow.dealsByParty · periodic</span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-deep mt-1">Loans</h1>
          <p className="mt-1 text-sm text-ink-soft max-w-2xl">
            Every loan you&apos;re a party to. Select one to run its{' '}
            <DocLink href={DOCS.dealLifecycle} title="The deal lifecycle">
              lifecycle
            </DocLink>{' '}
            and watch it amortize.
          </p>
        </div>
        <Link to="/loan" className="btn-primary whitespace-nowrap">
          New loan
        </Link>
      </div>

      {error && <div className="rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">{error}</div>}

      {loading ? (
        <div className="card text-sm text-ink-soft">Loading loans…</div>
      ) : deals.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-ink-soft">No loans yet.</p>
          <Link to="/loan" className="btn-primary mt-4 inline-flex">
            Create your first loan →
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
          <ul className="space-y-2">
            {deals.map((d) => {
              const m = parseLoan(d);
              const active = d.id === selectedId;
              return (
                <li key={d.id}>
                  <button
                    onClick={() => select(d.id)}
                    className={`w-full text-left rounded-xl border p-3 transition-colors ${
                      active ? 'border-brand-400 bg-brand-50' : 'border-line bg-white hover:bg-surface-alt'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink-deep truncate">{m?.loanName ?? d.name ?? d.id}</span>
                      <StatusPill status={d.status} />
                    </div>
                    <div className="mt-1 text-[11px] text-ink-soft">
                      {m?.principal != null
                        ? `${fmtMoney(m.principal)} ${m.denomination ?? ''} · ${m.interestPct ?? '—'}% · ${m.termPeriods} periods`
                        : 'Terms to be set'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          <div>
            {selected ? (
              <LoanDetail key={selected.id} deal={selected} callerId={callerId} entities={entities} onChanged={reload} />
            ) : (
              <div className="card text-sm text-ink-soft">Select a loan to manage it.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
