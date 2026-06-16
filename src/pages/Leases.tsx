import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '@yieldfabric/wallet';

import { StatusPill } from '../components/badges';
import LeaseDetail from '../components/LeaseDetail';
import { DOCS } from '../docs';
import DocLink from '../components/DocLink';
import { listMyDeals } from '../lib/dealFlow';
import { fetchEntities, type EntityOption } from '../lib/payments';
import { isRentalDeal, parseRental } from '../lib/rentalModel';
import type { Deal } from '../lib/dealTypes';

/**
 * Lesson 2+ — the rental lifecycle, rent roll, money loop, automation.
 *
 * Lists every rental the caller is a party to (`dealFlow.dealsByParty`,
 * filtered to rentals by `isRentalDeal`), and renders the selected one
 * with `<LeaseDetail>`. A rental is just a Deal — this page reads them
 * with the same query the first-party app uses, then projects each into
 * a rental view with `parseRental`.
 */
export default function Leases() {
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
      setDeals(all.filter((d) => isRentalDeal(d)));
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

  const selected = React.useMemo(
    () => deals.find((d) => d.id === selectedId) ?? null,
    [deals, selectedId]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <span className="mini-label">Lesson 2 · dealFlow.dealsByParty</span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-deep mt-1">Leases</h1>
          <p className="mt-1 text-sm text-ink-soft max-w-2xl">
            Every rental you&apos;re a party to. Select one to run its{' '}
            <DocLink href={DOCS.dealLifecycle} title="The deal lifecycle">
              lifecycle
            </DocLink>{' '}
            and money loop.
          </p>
        </div>
        <Link to="/lease" className="btn-primary whitespace-nowrap">
          New lease
        </Link>
      </div>

      {error && (
        <div className="rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card text-sm text-ink-soft">Loading leases…</div>
      ) : deals.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-ink-soft">No rentals yet.</p>
          <Link to="/lease" className="btn-primary mt-4 inline-flex">
            Create your first rental →
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
          {/* ── List ── */}
          <ul className="space-y-2">
            {deals.map((d) => {
              const m = parseRental(d);
              const active = d.id === selectedId;
              return (
                <li key={d.id}>
                  <button
                    onClick={() => select(d.id)}
                    className={`w-full text-left rounded-xl border p-3 transition-colors ${
                      active
                        ? 'border-brand-400 bg-brand-50'
                        : 'border-line bg-white hover:bg-surface-alt'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink-deep truncate">
                        {m?.propertyName ?? d.name ?? d.id}
                      </span>
                      <StatusPill status={d.status} />
                    </div>
                    <div className="mt-1 text-[11px] text-ink-soft">
                      {m?.rentAmount
                        ? `${m.rentAmount} ${m.denomination ?? ''} · ${m.schedule.length} payments`
                        : 'Rent to be set'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* ── Detail ── */}
          <div>
            {selected ? (
              <LeaseDetail
                key={selected.id}
                deal={selected}
                callerId={callerId}
                entities={entities}
                onChanged={reload}
              />
            ) : (
              <div className="card text-sm text-ink-soft">Select a lease to manage it.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
