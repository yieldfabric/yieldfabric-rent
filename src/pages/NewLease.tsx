import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@yieldfabric/wallet';

import DocLink from '../components/DocLink';
import { DOCS } from '../docs';
import { useAssets } from '../lib/useAssets';
import { fetchEntities, type EntityOption } from '../lib/payments';
import { saveDealDraft } from '../lib/dealFlow';
import {
  buildRentalDraft,
  firstOfNextMonthIso,
  DEFAULT_CADENCE_SECONDS,
  FREQUENCY_OPTIONS,
  type NewRentalParams,
  type RentFrequency,
} from '../lib/rentalModel';

/**
 * Lesson 1 — a rental is a deal plan.
 *
 * The form collects lease terms and `buildRentalDraft` turns them into a
 * 4-node `DealPlan`:
 *
 *   create_property      → create_group_account     (the property account)
 *   add_send_policy      → add_data_policy          (the agent's send authority)
 *   rent                 → create_composed_contract (the monthly rent obligation)
 *   accept_rent          → accept_obligation        (the tenant accepts)
 *
 * We save it as a DRAFT (`dealFlow.saveDealDraft`, federated gateway).
 * The deal lifecycle — propose → sign → activate — happens on the Leases
 * page (lesson 2). The live plan preview below is the exact JSON the DMS
 * will compile.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'error'; message: string };

export default function NewLease() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { assets } = useAssets();
  const [entities, setEntities] = React.useState<EntityOption[]>([]);
  const [entitiesError, setEntitiesError] = React.useState<string | null>(null);

  const [propertyName, setPropertyName] = React.useState('12 Smith St');
  const [tenantEntityId, setTenantEntityId] = React.useState('');
  const [selfManaged, setSelfManaged] = React.useState(true);
  const [agentEntityId, setAgentEntityId] = React.useState('');
  const [denomination, setDenomination] = React.useState('');
  const [rentAmount, setRentAmount] = React.useState('1000');
  const [frequency, setFrequency] = React.useState<RentFrequency>('monthly');
  const [payments, setPayments] = React.useState(6);
  const [startDate, setStartDate] = React.useState(firstOfNextMonthIso());
  const [customDates, setCustomDates] = React.useState<string[]>([firstOfNextMonthIso()]);
  const [floorAmount, setFloorAmount] = React.useState('5000');
  const [capAmount, setCapAmount] = React.useState('2000');
  const [cadenceSeconds, setCadenceSeconds] = React.useState(DEFAULT_CADENCE_SECONDS);

  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });

  const landlordEntityId = user?.id ?? '';

  React.useEffect(() => {
    fetchEntities()
      .then(setEntities)
      .catch((e: Error) => setEntitiesError(e.message));
  }, []);

  React.useEffect(() => {
    if (!denomination && assets.length > 0) setDenomination(assets[0].id);
  }, [assets, denomination]);

  const params: NewRentalParams = React.useMemo(
    () => ({
      propertyName,
      landlordEntityId,
      tenantEntityId,
      agentEntityId: selfManaged ? landlordEntityId : agentEntityId,
      rentAmount,
      frequency,
      payments,
      customDates,
      startDate,
      floorAmount,
      capAmount,
      denomination: denomination || undefined,
      cadenceSeconds,
    }),
    [
      propertyName,
      landlordEntityId,
      tenantEntityId,
      selfManaged,
      agentEntityId,
      rentAmount,
      frequency,
      payments,
      customDates,
      startDate,
      floorAmount,
      capAmount,
      denomination,
      cadenceSeconds,
    ]
  );

  // The live plan preview — exactly what saveDealDraft sends.
  const draftPreview = React.useMemo(() => {
    try {
      return buildRentalDraft(params);
    } catch {
      return null;
    }
  }, [params]);

  const working = phase.kind === 'working';
  const tenantOptions = entities.filter((e) => e.id !== landlordEntityId);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantEntityId) {
      setPhase({ kind: 'error', message: 'Pick a tenant.' });
      return;
    }
    if (!selfManaged && !agentEntityId) {
      setPhase({ kind: 'error', message: 'Pick a managing agent (or manage it yourself).' });
      return;
    }
    setPhase({ kind: 'working', label: 'Saving the rental draft…' });
    try {
      const draft = buildRentalDraft(params);
      const deal = await saveDealDraft({
        name: draft.name,
        parties: draft.parties,
        plan: draft.plan,
      });
      // Hand off to the Leases page with the new draft selected, where
      // the lifecycle (Send → Sign → Activate) continues.
      navigate(`/leases?id=${encodeURIComponent(deal.id)}`);
    } catch (err) {
      setPhase({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <span className="mini-label">Lesson 1 · dealFlow.saveDealDraft</span>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-deep mt-1">New lease</h1>
        <p className="mt-2 text-sm text-ink-soft max-w-2xl">
          Define the lease terms; the app builds a 4-node{' '}
          <DocLink href={DOCS.dms} title="The deal-management system">
            DMS deal plan
          </DocLink>{' '}
          and saves it as a draft. You&apos;ll propose, sign, and activate it on the{' '}
          <Link to="/leases" className="text-brand-600 hover:underline">
            Leases
          </Link>{' '}
          page.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
        {/* ── Terms ── */}
        <form onSubmit={create} className="card space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-deep">Lease terms</h2>
            <span className="mini-label">the 4-node plan</span>
          </div>

          {entitiesError && (
            <p className="text-xs text-status-error-text">Couldn&apos;t load entities: {entitiesError}</p>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">Property</span>
            <input
              className="field"
              value={propertyName}
              onChange={(e) => setPropertyName(e.target.value)}
              required
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">Tenant</span>
            <select
              className="field"
              value={tenantEntityId}
              onChange={(e) => setTenantEntityId(e.target.value)}
              required
            >
              <option value="">Select a tenant…</option>
              {tenantOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.id.slice(0, 10)}…)
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-ink-mute">
              The tenant is the rent obligation&apos;s obligor (payer) and counterpart — an
              entity, never a 0x… address.
            </span>
          </label>

          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-ink-soft mb-1">
              <input
                type="checkbox"
                checked={selfManaged}
                onChange={(e) => setSelfManaged(e.target.checked)}
              />
              I&apos;ll manage this property myself
            </label>
            {!selfManaged && (
              <select
                className="field"
                value={agentEntityId}
                onChange={(e) => setAgentEntityId(e.target.value)}
                required
              >
                <option value="">Select a managing agent…</option>
                {entities
                  .filter((e) => e.id !== landlordEntityId)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({e.id.slice(0, 10)}…)
                    </option>
                  ))}
              </select>
            )}
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">Rent asset</span>
            <select
              className="field"
              value={denomination}
              onChange={(e) => setDenomination(e.target.value)}
            >
              {assets.length === 0 && <option value="aud-token-asset">aud-token-asset</option>}
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || a.currency || a.id} ({a.id})
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-ink-soft mb-1">Rent / payment</span>
              <input
                className="field"
                type="number"
                min="0"
                step="0.01"
                value={rentAmount}
                onChange={(e) => setRentAmount(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-soft mb-1">Frequency</span>
              <select
                className="field"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as RentFrequency)}
              >
                {FREQUENCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {frequency === 'custom' ? (
            <div>
              <span className="block text-xs font-medium text-ink-soft mb-1">Payment dates</span>
              <div className="space-y-2">
                {customDates.map((d, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      className="field"
                      type="datetime-local"
                      value={d}
                      onChange={(e) =>
                        setCustomDates((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                      }
                    />
                    <button
                      type="button"
                      className="btn-secondary !px-3"
                      onClick={() => setCustomDates((prev) => prev.filter((_, j) => j !== i))}
                      disabled={customDates.length <= 1}
                      title="Remove this date"
                    >
                      −
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-secondary !py-1.5 text-xs"
                  onClick={() => setCustomDates((prev) => [...prev, firstOfNextMonthIso()])}
                >
                  + Add date
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-xs font-medium text-ink-soft mb-1">Payments</span>
                <input
                  className="field"
                  type="number"
                  min="1"
                  max="60"
                  value={payments}
                  onChange={(e) => setPayments(Number(e.target.value))}
                  required
                />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-ink-soft mb-1">First rent due</span>
                <input
                  className="field"
                  type="datetime-local"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </label>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-ink-soft mb-1">Agent send floor</span>
              <input
                className="field"
                type="number"
                min="0"
                value={floorAmount}
                onChange={(e) => setFloorAmount(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-ink-mute">
                Agent may only send while the account holds ≥ this.
              </span>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-soft mb-1">Per-transfer cap</span>
              <input
                className="field"
                type="number"
                min="0"
                value={capAmount}
                onChange={(e) => setCapAmount(e.target.value)}
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1">
              Automation check interval (seconds)
            </span>
            <input
              className="field"
              type="number"
              min="0"
              value={cadenceSeconds}
              onChange={(e) => setCadenceSeconds(Number(e.target.value))}
            />
            <span className="mt-1 block text-[11px] text-ink-mute">
              How often the rent worker scans this deal once a side arms automation. 0 ⇒ worker
              default ({DEFAULT_CADENCE_SECONDS}s).
            </span>
          </label>

          {phase.kind === 'error' && (
            <div className="rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">
              {phase.message}
            </div>
          )}

          <button type="submit" className="btn-primary w-full" disabled={working}>
            {working ? 'Saving draft…' : 'Create rental draft'}
          </button>
        </form>

        {/* ── Live plan preview ── */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-ink-deep">DealPlan preview</h2>
            <span className="mini-label">what the DMS compiles</span>
          </div>
          <p className="text-xs text-ink-soft mb-3">
            The exact draft this form sends to <code className="bg-surface-alt px-1 rounded">saveDealDraft</code>.
            Note the snake_case plan keys (the Rust serde shape) and the{' '}
            <code className="bg-surface-alt px-1 rounded">$step.X.Y</code> references the runtime
            resolves between nodes.
          </p>
          <pre className="text-[11px] leading-relaxed bg-surface-alt rounded-lg p-3 overflow-auto max-h-[34rem] text-ink">
            {draftPreview
              ? JSON.stringify(draftPreview, null, 2)
              : '// fill in the terms to preview the plan'}
          </pre>
        </div>
      </div>
    </div>
  );
}
