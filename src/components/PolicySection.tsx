import React from 'react';
import { useGenericSigner } from '@yieldfabric/wallet/react/useGenericSigner';
import { keysService } from '@yieldfabric/wallet/core/keysService';
import { tokenManager } from '@yieldfabric/wallet/core/tokenManager';

import DocLink from './DocLink';
import { Pill } from './badges';
import { DOCS } from '../docs';
import {
  fetchPolicies,
  addDataPolicy,
  removeDataPolicy,
  approveDataPolicy,
  sendUnderPolicy,
  type PolicyInfo,
} from '../lib/policy';
import { humanToWei, toLocalInputValue, localInputToInstant } from '../lib/rentalModel';
import type { RentalModel } from '../lib/rentalModel';
import type { EntityOption } from '../lib/payments';

/**
 * Agent send policy — the on-chain, balance-gated authorisation that lets
 * the managing agent disburse from the property account.
 *
 *   View      everyone (landlord + agent): the registered terms + approval.
 *   Approve   landlord (required signer): one personal signature → the
 *             reusable M-of-N artifact every send re-attaches.
 *   Add       landlord: register an additional policy.
 *   Novate    landlord: register a SUCCESSOR with amended terms (the chain
 *             forbids in-place edits; the predecessor ages out).
 *   Retire    landlord: revoke a policy on-chain (new accounts only).
 *   Send      agent (or landlord): disburse under the policy — the chain
 *             enforces the cap + balance floor + use count.
 */

function Err({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-2 rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">
      {message}
    </div>
  );
}
function Done({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-2 rounded-md bg-status-success-bg text-status-success-text px-3 py-2 text-xs">
      {message}
    </div>
  );
}

function fmtExpiry(exp: string): string {
  if (!exp) return '—';
  const d = /^\d+$/.test(exp) ? new Date(Number(exp) > 1e12 ? Number(exp) : Number(exp) * 1000) : new Date(exp);
  return Number.isNaN(d.getTime()) ? exp : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function PolicySection({
  model,
  callerId,
  isLandlord,
  isAgent,
  groupEntityId,
  propertyWalletId,
  entities,
}: {
  model: RentalModel;
  callerId: string;
  isLandlord: boolean;
  isAgent: boolean;
  groupEntityId: string | null;
  propertyWalletId: string | null;
  entities: EntityOption[];
}) {
  const { signMessage } = useGenericSigner();

  const entityName = (id: string | null | undefined) =>
    !id ? '—' : entities.find((e) => e.id === id)?.name ?? `${id.slice(0, 12)}…`;

  const [policies, setPolicies] = React.useState<PolicyInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [supersededIds, setSupersededIds] = React.useState<string[]>([]);
  const [activePolicyId, setActivePolicyId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    if (!propertyWalletId) return;
    setLoading(true);
    try {
      setPolicies(await fetchPolicies(propertyWalletId, model.denomination));
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, [propertyWalletId, model.denomination]);
  React.useEffect(() => {
    void reload();
  }, [reload]);

  // The rental's registered policy — successor (if novated) → the rental's
  // own live policy → first live → first.
  const registeredPolicy: PolicyInfo | null =
    (activePolicyId ? policies.find((p) => p.policyId === activePolicyId) : null) ??
    policies.find((p) => p.policyId === (model.policy?.policyId ?? '1') && !p.revoked) ??
    policies.find((p) => !p.revoked) ??
    policies.find((p) => p.policyId === (model.policy?.policyId ?? '1')) ??
    policies[0] ??
    null;

  // ── Approve (landlord, required signer) ──────────────────────────
  const [approveBusy, setApproveBusy] = React.useState(false);
  const [approveError, setApproveError] = React.useState<string | null>(null);
  const approve = async () => {
    const digest = registeredPolicy?.approval?.registeredDigest;
    if (!registeredPolicy || !digest || !propertyWalletId || !callerId) return;
    const current = tokenManager.getCurrentToken();
    const delegation = tokenManager.getDelegationToken();
    if (current && delegation && current === delegation) {
      setApproveError('You are acting as a group — switch back to your own account to approve (the approval is your personal signature).');
      return;
    }
    setApproveError(null);
    setApproveBusy(true);
    try {
      const keys = await keysService.getUserKeyPairs(callerId);
      const signing = keys
        .filter((k) => k.is_active && String(k.key_type).toLowerCase() === 'signing')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      if (!signing) {
        setApproveError('No active signing key available to approve with.');
        return;
      }
      const signature = await signMessage(digest, { keySelection: { mode: 'keyId', keyId: signing.id } });
      await approveDataPolicy({ account: propertyWalletId, policyId: registeredPolicy.policyId, signature });
      await reload();
    } catch (e) {
      setApproveError((e as Error).message);
    } finally {
      setApproveBusy(false);
    }
  };

  // ── Retire (landlord) ────────────────────────────────────────────
  const [retireConfirm, setRetireConfirm] = React.useState(false);
  const [retireBusy, setRetireBusy] = React.useState(false);
  const [lifecycleError, setLifecycleError] = React.useState<string | null>(null);
  const [lifecycleDone, setLifecycleDone] = React.useState<string | null>(null);
  const retire = async () => {
    if (!registeredPolicy || !groupEntityId || !propertyWalletId) return;
    setLifecycleError(null);
    setLifecycleDone(null);
    setRetireBusy(true);
    try {
      await removeDataPolicy({ account: propertyWalletId, policyId: registeredPolicy.policyId, groupEntityId });
      setLifecycleDone(`Policy ${registeredPolicy.policyId} revoked on-chain. Register a successor with Novate or Add policy if the rental still needs one.`);
      setActivePolicyId(null);
      await reload();
    } catch (e) {
      const msg = (e as Error).message;
      setLifecycleError(
        /selector|fallback|revert/i.test(msg)
          ? 'This property account predates on-chain policy removal — only new-implementation accounts support Retire. Use Novate instead (the old policy ages out at its expiry).'
          : msg
      );
    } finally {
      setRetireBusy(false);
      setRetireConfirm(false);
    }
  };

  // ── Add / Novate form (landlord) ─────────────────────────────────
  const [form, setForm] = React.useState<null | { mode: 'add' | 'novate'; fromPolicyId?: string }>(null);
  const [pfExecutor, setPfExecutor] = React.useState('');
  const [pfFloor, setPfFloor] = React.useState('');
  const [pfCap, setPfCap] = React.useState('');
  const [pfUses, setPfUses] = React.useState('8');
  const [pfExpiry, setPfExpiry] = React.useState('');
  const [pfBusy, setPfBusy] = React.useState(false);

  const openForm = (mode: 'add' | 'novate') => {
    setLifecycleError(null);
    setLifecycleDone(null);
    const from = mode === 'novate' ? registeredPolicy : null;
    setForm({ mode, fromPolicyId: from?.policyId });
    setPfExecutor(model.agentEntityId ?? callerId);
    // Floor is committed on-chain (unreadable) — only the original plan's is known.
    setPfFloor(
      mode === 'novate' && from && from.policyId !== (model.policy?.policyId ?? '1')
        ? ''
        : (model.policy?.floor ?? '').replace(/,/g, '')
    );
    setPfCap((from?.capHuman ?? model.policy?.cap ?? '').replace(/,/g, ''));
    setPfUses(from?.maxUse && from.maxUse !== '0' ? from.maxUse : '8');
    const exp = (from?.expiry ?? registeredPolicy?.expiry ?? '').trim();
    if (/^\d+$/.test(exp)) {
      const n = Number(exp);
      setPfExpiry(toLocalInputValue(new Date(n > 1e12 ? n : n * 1000)));
    } else if (exp) {
      const d = new Date(exp);
      setPfExpiry(Number.isNaN(d.getTime()) ? '' : toLocalInputValue(d));
    } else {
      setPfExpiry('');
    }
  };

  const submitForm = async () => {
    if (!form) return;
    const executor = pfExecutor.trim();
    const cap = pfCap.trim().replace(/,/g, '');
    const floor = pfFloor.trim().replace(/,/g, '');
    const usesN = Math.max(0, Math.floor(Number(pfUses.replace(/,/g, '')) || 0));
    if (!executor) return setLifecycleError('Pick an executor.');
    if (!pfExpiry.trim()) return setLifecycleError('Set an expiry.');
    if (usesN < 1) return setLifecycleError('Uses must be at least 1.');
    if (!groupEntityId || !propertyWalletId || !model.denominationAssetId) {
      return setLifecycleError('The property account is still resolving — try again in a moment.');
    }
    setLifecycleError(null);
    setLifecycleDone(null);
    setPfBusy(true);
    try {
      const newId = String(Date.now());
      await addDataPolicy({
        account: propertyWalletId,
        policyId: newId,
        expiryIso: localInputToInstant(pfExpiry).toISOString(),
        maxUse: usesN,
        requiredSignerEntityId: callerId,
        executor,
        denomination: model.denominationAssetId,
        capHuman: cap,
        floorHuman: floor,
        groupEntityId,
      });
      if (form.mode === 'novate' && form.fromPolicyId) {
        const fromId = form.fromPolicyId;
        setSupersededIds((prev) => (prev.includes(fromId) ? prev : [...prev, fromId]));
      }
      setActivePolicyId(newId);
      setLifecycleDone(
        form.mode === 'novate'
          ? `Policy novated — successor ${newId} is registered and approved. The previous policy is superseded but stays valid on-chain until it ages out.`
          : `Policy ${newId} registered and approved.`
      );
      setForm(null);
      await reload();
    } catch (e) {
      setLifecycleError((e as Error).message);
    } finally {
      setPfBusy(false);
    }
  };

  // ── Send under policy (agent + landlord) ─────────────────────────
  const [sendPolicyId, setSendPolicyId] = React.useState('');
  React.useEffect(() => {
    const firstLive = policies.find((p) => !p.revoked)?.policyId;
    setSendPolicyId((cur) => (cur && policies.some((p) => p.policyId === cur && !p.revoked) ? cur : firstLive ?? ''));
  }, [policies]);
  const [sendOpen, setSendOpen] = React.useState(false);
  const [sendDest, setSendDest] = React.useState('');
  const [sendAmount, setSendAmount] = React.useState('');
  const [sendBusy, setSendBusy] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sendDone, setSendDone] = React.useState<string | null>(null);
  const send = async () => {
    const execPolicy = policies.find((p) => p.policyId === sendPolicyId);
    if (!execPolicy || !groupEntityId || !propertyWalletId) return;
    if (execPolicy.revoked) return setSendError(`Policy ${sendPolicyId} was revoked — pick another or Novate.`);
    const policyToken = execPolicy.bounds[0]?.token?.trim();
    if (!policyToken || !policyToken.startsWith('0x')) return setSendError('This policy has no bounded token to send.');
    if (!sendDest.trim()) return setSendError('Enter a destination wallet id or address.');
    if (!(Number(sendAmount.replace(/,/g, '')) > 0)) return setSendError('Enter an amount.');
    setSendError(null);
    setSendDone(null);
    setSendBusy(true);
    try {
      await sendUnderPolicy({
        account: propertyWalletId,
        policyId: sendPolicyId,
        tokenAddress: policyToken,
        destination: sendDest.trim().replace(/^WLT-/i, ''),
        amountRaw: humanToWei(sendAmount),
        groupEntityId,
      });
      setSendDone(`Sent ${sendAmount} ${model.denomination ?? ''} under policy ${sendPolicyId}.`);
      setSendOpen(false);
      setSendAmount('');
      setSendDest('');
      await reload();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSendBusy(false);
    }
  };

  const livePolicies = policies.filter((p) => !p.revoked);
  const approvalOk = !!registeredPolicy?.approval?.approved;

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-sm font-semibold text-ink-deep">Agent send policy</h3>
        <DocLink href={DOCS.dataPolicies} className="text-[11px] text-brand-600 hover:underline">
          Data policies ↗
        </DocLink>
      </div>

      {!registeredPolicy ? (
        <p className="text-xs text-ink-mute">
          {loading ? 'Loading policy…' : 'No send policy registered on this property account yet.'}
        </p>
      ) : (
        <>
          {/* ── Registered terms ── */}
          <div className="rounded-lg border border-line p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">{registeredPolicy.label}</span>
              {registeredPolicy.revoked ? (
                <Pill tone="error">Revoked</Pill>
              ) : approvalOk ? (
                <Pill tone="success">Approved</Pill>
              ) : (
                <Pill tone="warning">
                  Approval {registeredPolicy.approval?.collected ?? 0}/{registeredPolicy.approval?.min ?? registeredPolicy.minSignatories}
                </Pill>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-[12px]">
              <div>
                <dt className="mini-label">Managing agent</dt>
                <dd className="text-ink-soft truncate">{entityName(registeredPolicy.executors[0] ?? model.agentEntityId)}</dd>
              </div>
              <div>
                <dt className="mini-label">Per-send cap</dt>
                <dd className="text-ink-soft">{registeredPolicy.capHuman ? `${registeredPolicy.capHuman} ${model.denomination ?? ''}` : '—'}</dd>
              </div>
              <div>
                <dt className="mini-label">Balance floor</dt>
                <dd className="text-ink-soft">{model.policy?.floor ? `${model.policy.floor} ${model.denomination ?? ''}` : '—'}</dd>
              </div>
              <div>
                <dt className="mini-label">Uses</dt>
                <dd className="text-ink-soft">
                  {registeredPolicy.uses ?? 0}
                  {registeredPolicy.maxUse && registeredPolicy.maxUse !== '0' ? ` / ${registeredPolicy.maxUse}` : ''}
                </dd>
              </div>
              <div>
                <dt className="mini-label">Expiry</dt>
                <dd className="text-ink-soft">{fmtExpiry(registeredPolicy.expiry)}</dd>
              </div>
              <div>
                <dt className="mini-label">Required signer</dt>
                <dd className="text-ink-soft truncate">{entityName(registeredPolicy.requiredSignerEntityIds[0] ?? model.landlordEntityId)}</dd>
              </div>
            </dl>
            {supersededIds.includes(registeredPolicy.policyId) && (
              <p className="mt-2 text-[11px] text-ink-mute">Superseded by a novation — valid until it ages out.</p>
            )}
          </div>

          {/* ── Landlord controls ── */}
          {isLandlord && !form && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!registeredPolicy.revoked && !approvalOk && registeredPolicy.approval?.registeredDigest && (
                <button className="btn-primary !py-1.5 text-xs" disabled={approveBusy} onClick={approve}>
                  {approveBusy ? 'Approving…' : 'Approve now'}
                </button>
              )}
              {!registeredPolicy.revoked && (
                <button className="btn-secondary !py-1.5 text-xs" onClick={() => openForm('novate')}>
                  Novate
                </button>
              )}
              {!registeredPolicy.revoked &&
                (retireConfirm ? (
                  <button className="btn-secondary !py-1.5 text-xs text-status-error-text" disabled={retireBusy} onClick={retire}>
                    {retireBusy ? 'Retiring…' : `Retire policy ${registeredPolicy.policyId}?`}
                  </button>
                ) : (
                  <button className="btn-secondary !py-1.5 text-xs" onClick={() => setRetireConfirm(true)}>
                    Retire
                  </button>
                ))}
              <button className="btn-secondary !py-1.5 text-xs" onClick={() => openForm('add')}>
                Add policy
              </button>
            </div>
          )}
          <Err message={approveError} />

          {/* ── Add / novate form ── */}
          {isLandlord && form && (
            <div className="mt-3 rounded-lg border border-line p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-ink-deep">
                  {form.mode === 'novate' ? `Novate policy ${form.fromPolicyId ?? ''}` : 'Add a policy'}
                </span>
                <button className="text-xs text-ink-soft hover:text-ink" onClick={() => setForm(null)}>
                  Cancel
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-xs font-medium text-ink-soft mb-1">Managing agent (executor)</span>
                  <select className="field" value={pfExecutor} onChange={(e) => setPfExecutor(e.target.value)}>
                    {model.agentEntityId && (
                      <option value={model.agentEntityId}>{entityName(model.agentEntityId)}</option>
                    )}
                    {entities
                      .filter((e) => e.id !== model.agentEntityId)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} ({e.id.slice(0, 10)}…)
                        </option>
                      ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-ink-soft mb-1">Expiry</span>
                  <input className="field" type="datetime-local" value={pfExpiry} onChange={(e) => setPfExpiry(e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-ink-soft mb-1">Per-transfer cap</span>
                  <input className="field" type="number" min="0" value={pfCap} onChange={(e) => setPfCap(e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-ink-soft mb-1">Balance floor</span>
                  <input className="field" type="number" min="0" value={pfFloor} onChange={(e) => setPfFloor(e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-ink-soft mb-1">Uses</span>
                  <input className="field" type="number" min="1" value={pfUses} onChange={(e) => setPfUses(e.target.value)} />
                </label>
              </div>
              <button className="btn-primary !py-1.5 text-xs" disabled={pfBusy} onClick={submitForm}>
                {pfBusy ? 'Registering…' : form.mode === 'novate' ? 'Register successor' : 'Register policy'}
              </button>
            </div>
          )}
          <Err message={lifecycleError} />
          <Done message={lifecycleDone} />

          {/* ── Send under policy (agent + landlord) ── */}
          {livePolicies.length > 0 && (
            <div className="mt-3 border-t border-line-soft pt-3">
              <div className="flex items-center justify-between">
                <span className="mini-label">Disburse under policy</span>
                {!sendOpen && (
                  <button className="text-xs text-brand-600 hover:underline" onClick={() => { setSendOpen(true); setSendError(null); setSendDone(null); }}>
                    Send funds
                  </button>
                )}
              </div>
              {sendOpen && (
                <div className="mt-2 space-y-3">
                  {livePolicies.length > 1 && (
                    <label className="block">
                      <span className="block text-xs font-medium text-ink-soft mb-1">Policy</span>
                      <select className="field" value={sendPolicyId} onChange={(e) => setSendPolicyId(e.target.value)}>
                        {livePolicies.map((p) => (
                          <option key={p.policyId} value={p.policyId}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="block">
                    <span className="block text-xs font-medium text-ink-soft mb-1">Destination (wallet id / address)</span>
                    <input className="field" value={sendDest} onChange={(e) => setSendDest(e.target.value)} placeholder="WLT-0x… or 0x…" />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-ink-soft mb-1">Amount</span>
                    <input className="field" type="number" min="0" step="0.01" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />
                  </label>
                  <div className="flex items-center gap-2">
                    <button className="btn-primary !py-1.5 text-xs" disabled={sendBusy} onClick={send}>
                      {sendBusy ? 'Sending…' : 'Send under policy'}
                    </button>
                    <button className="btn-secondary !py-1.5 text-xs" onClick={() => setSendOpen(false)}>
                      Cancel
                    </button>
                  </div>
                  <p className="text-[11px] text-ink-mute">
                    The chain enforces the cap + balance floor + use count — an over-cap or
                    floor-breaching send reverts.
                  </p>
                </div>
              )}
              <Err message={sendError} />
              <Done message={sendDone} />
            </div>
          )}
        </>
      )}

      {isAgent && !registeredPolicy && !loading && (
        <p className="mt-2 text-[11px] text-ink-mute">
          You&apos;re the managing agent — once the landlord activates the lease and the policy is
          approved, you can disburse here.
        </p>
      )}
    </section>
  );
}
