import React from 'react';
import { IncomingPaymentsInbox, SendPaymentDrawer, useAuth } from '@yieldfabric/wallet';
import type { SendPaymentAsset } from '@yieldfabric/wallet';

import DocLink from '../components/DocLink';
import { Pill } from '../components/badges';
import { DOCS } from '../docs';
import { fetchJwtInfo, type JwtInfo } from '../lib/session';
import { fetchBalance, waitForMessage } from '../lib/graphql';
import { useAssets } from '../lib/useAssets';
import { fetchWallet, paymentPositions, acceptPayment, type PaymentHolding, type WalletView } from '../lib/wallet';
import { formatRawAmount } from '../lib/format';
import { humanizeDenomination, vaultBalanceToHuman } from '../lib/rentalModel';

/**
 * Wallet — balances + contracts, with send + accept.
 *
 * Modeled on the first-party app's wallet detail page
 * (`yieldfabric-app/src/pages/wallets/[walletId].tsx`):
 *
 *   BALANCES   the confidential balance the wallet holds per asset, read
 *              off the vault (`/balance`, REST — lib/graphql.ts).
 *   CONTRACTS  the obligations / payment legs the wallet is party to —
 *              the `Payment`-typed positions from `GET_WALLET_BY_ID`
 *              (lib/wallet.ts), each with a status and an Accept action.
 *   SEND       `<SendPaymentDrawer>` (wallet-SDK): the host supplies the
 *              asset catalog, the SDK owns the form + the `instant`
 *              mutation + manual-signature routing.
 *   ACCEPT     two ways — the explicit `accept` mutation per obligation
 *              (the same the first-party page fires), and the SDK's
 *              `<IncomingPaymentsInbox>` for everything awaiting you.
 */

interface AssetBalance {
  assetId: string;
  label: string;
  human: string;
}

function statusTone(status?: string | null): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
  const s = (status ?? '').toUpperCase();
  if (['COMPLETED', 'PAID', 'ACCEPTED'].includes(s)) return 'success';
  if (['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(s)) return 'error';
  if (['DUE', 'OVERDUE'].includes(s)) return 'warning';
  if (s) return 'info';
  return 'neutral';
}

export default function Wallet() {
  const { user } = useAuth();
  const callerId = user?.id ?? '';
  const { assets } = useAssets();

  const [jwt, setJwt] = React.useState<JwtInfo | null>(null);
  const [walletId, setWalletId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [balances, setBalances] = React.useState<AssetBalance[]>([]);
  const [balancesLoading, setBalancesLoading] = React.useState(false);

  const [wallet, setWallet] = React.useState<WalletView | null>(null);
  const [walletLoading, setWalletLoading] = React.useState(false);

  const [sendOpen, setSendOpen] = React.useState(false);
  const [acceptingId, setAcceptingId] = React.useState<string | null>(null);
  const [acceptError, setAcceptError] = React.useState<string | null>(null);

  // ── Loaders ────────────────────────────────────────────────────────
  const loadBalances = React.useCallback(async () => {
    if (assets.length === 0) return;
    setBalancesLoading(true);
    try {
      const rows = await Promise.all(
        assets.map(async (a) => {
          const b = await fetchBalance(a.id).catch(() => ({ raw: '0', decimals: '1000000000000000000' }));
          return {
            assetId: a.id,
            label: a.currency || a.name || humanizeDenomination(a.id) || a.id,
            human: vaultBalanceToHuman(b.raw, b.decimals),
          };
        })
      );
      setBalances(rows);
    } finally {
      setBalancesLoading(false);
    }
  }, [assets]);

  const loadWallet = React.useCallback(async (wid: string) => {
    setWalletLoading(true);
    try {
      setWallet(await fetchWallet(wid));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWalletLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchJwtInfo()
      .then((info) => {
        setJwt(info);
        if (info.default_wallet_id) {
          setWalletId(info.default_wallet_id);
          void loadWallet(info.default_wallet_id);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [loadWallet]);

  React.useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  // ── Accept an obligation / payment ─────────────────────────────────
  const accept = async (p: PaymentHolding) => {
    setAcceptError(null);
    setAcceptingId(p.id);
    try {
      const r = await acceptPayment(p.id, p.payee?.wallet?.id ?? walletId ?? undefined);
      if (r.messageId) await waitForMessage(callerId, r.messageId);
      if (walletId) await loadWallet(walletId);
      await loadBalances();
    } catch (e) {
      setAcceptError((e as Error).message);
    } finally {
      setAcceptingId(null);
    }
  };

  const sendAssets: SendPaymentAsset[] = React.useMemo(
    () =>
      assets.map((a) => ({
        id: a.id,
        currency: a.currency || a.name || a.id,
        name: a.name ?? undefined,
      })),
    [assets]
  );

  const contracts = paymentPositions(wallet);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="mini-label">GET_WALLET_BY_ID · /balance · accept</span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-deep mt-1">Wallet</h1>
          <p className="mt-2 text-sm text-ink-soft max-w-2xl">
            Your wallet&apos;s balances and the contracts it holds, with send + accept — the same
            shape as the first-party{' '}
            <DocLink href={DOCS.paymentLifecycle} title="Payment lifecycle">
              wallet page
            </DocLink>
            .
          </p>
        </div>
        <button
          className="btn-primary whitespace-nowrap"
          onClick={() => setSendOpen(true)}
          disabled={assets.length === 0}
        >
          Send payment
        </button>
      </div>

      {error && <div className="rounded-md bg-status-error-bg text-status-error-text px-3 py-2 text-xs">{error}</div>}

      {/* ── Identity ── */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-deep">This wallet</h2>
          <span className="mini-label">/protected/jwt</span>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="mini-label">Wallet id</dt>
            <dd className="text-ink mt-0.5 font-mono text-xs break-all">{walletId ?? '…'}</dd>
          </div>
          <div>
            <dt className="mini-label">Smart-account address</dt>
            <dd className="text-ink mt-0.5 font-mono text-xs break-all">{jwt?.account_address ?? '…'}</dd>
          </div>
          <div>
            <dt className="mini-label">Entity</dt>
            <dd className="text-ink mt-0.5 truncate">{user?.email ?? user?.id ?? '…'}</dd>
          </div>
        </dl>
      </section>

      {/* ── Balances ── */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-deep">Balances</h2>
          <div className="flex items-center gap-3">
            <span className="mini-label">vault · /balance</span>
            <button
              className="text-xs text-brand-600 hover:underline disabled:opacity-50"
              disabled={balancesLoading}
              onClick={() => void loadBalances()}
            >
              {balancesLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        {balances.length === 0 ? (
          <p className="text-xs text-ink-mute">
            {balancesLoading ? 'Loading balances…' : 'No assets in the catalog.'}
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {balances.map((b) => (
              <li key={b.assetId} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{b.label}</span>
                  <span className="ml-2 font-mono text-[11px] text-ink-mute break-all">{b.assetId}</span>
                </div>
                <span className="text-ink tabular-nums whitespace-nowrap">{b.human}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-ink-mute">
          The confidential balance per asset, read with no obligor (your liquid cash). The rent
          loop also produces obligor-bound <em>credit</em> — see a lease&apos;s detail.
        </p>
      </section>

      {/* ── Contracts / obligations ── */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-deep">Contracts &amp; obligations</h2>
          <div className="flex items-center gap-3">
            <span className="mini-label">wallet positions</span>
            <button
              className="text-xs text-brand-600 hover:underline disabled:opacity-50"
              disabled={!walletId || walletLoading}
              onClick={() => walletId && loadWallet(walletId)}
            >
              {walletLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        {acceptError && <p className="text-xs text-status-error-text mb-2">{acceptError}</p>}
        {contracts.length === 0 ? (
          <p className="text-xs text-ink-mute">
            {walletLoading
              ? 'Loading…'
              : 'No contracts or obligations held by this wallet yet. Accept a lease or receive a payment and refresh.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {contracts.map((p) => {
              const amount = formatRawAmount(p.amount ?? p.balance);
              const ccy = p.asset?.currency ? humanizeDenomination(p.asset.currency) : '';
              const payer = p.payer?.entity?.name;
              const payee = p.payee?.entity?.name;
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="text-ink truncate">
                      {p.contract?.name ?? p.contractId ?? p.paymentType ?? 'Obligation'}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-mute truncate">
                      {amount} {ccy}
                      {payer && payee ? ` · ${payer} → ${payee}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Pill tone={statusTone(p.status)}>{p.status ?? '—'}</Pill>
                    {p.canAccept && (
                      <button
                        className="btn-secondary !py-1 text-xs"
                        disabled={acceptingId === p.id}
                        onClick={() => accept(p)}
                      >
                        {acceptingId === p.id ? 'Accepting…' : 'Accept'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Incoming (SDK inbox) ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-deep">Incoming</h2>
          <span className="mini-label">wallet-SDK · IncomingPaymentsInbox</span>
        </div>
        <IncomingPaymentsInbox />
      </section>

      <SendPaymentDrawer
        isOpen={sendOpen}
        onClose={() => setSendOpen(false)}
        assets={sendAssets}
        onSent={() => {
          if (walletId) void loadWallet(walletId);
          void loadBalances();
        }}
      />
    </div>
  );
}
