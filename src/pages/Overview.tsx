import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@yieldfabric/wallet';
import { fetchJwtInfo, JwtInfo } from '../lib/session';
import { DOCS } from '../docs';

/**
 * Overview — the tutorial. Answers two questions before you touch a thing:
 * how does a rental flow work, and what does each role do? The wire-level
 * reference lives in the collapsible "Under the hood" at the bottom.
 */

const ROLES: Array<{ title: string; tag: string; what: string }> = [
  {
    title: 'Landlord',
    tag: 'owns the property account',
    what: 'Composes the lease, sends it for signing, and activates it. Then collects rent, exchanges it for cash, and manages the managing-agent send policy.',
  },
  {
    title: 'Tenant',
    tag: 'the payer',
    what: 'Reviews and signs the lease, accepts the rent obligation (which escrows the rent), and settles each payment for cash — or arms auto-settle.',
  },
  {
    title: 'Managing agent',
    tag: 'optional',
    what: 'Disburses from the property account within a policy the landlord approves (a per-send cap + balance floor). If the landlord self-manages, this is them.',
  },
];

const LIFECYCLE: Array<{ n: number; stage: string; who: string; what: string }> = [
  {
    n: 1,
    stage: 'Compose',
    who: 'landlord',
    what: 'Fill in the property, tenant, agent, rent schedule, and the agent’s send policy. The app turns it into a 4-step deal plan and saves it as a draft.',
  },
  {
    n: 2,
    stage: 'Sign-off',
    who: 'tenant + agent',
    what: 'The landlord proposes the draft; the parties review the terms and sign. A deal only activates once everyone has signed.',
  },
  {
    n: 3,
    stage: 'Live',
    who: 'landlord, then tenant',
    what: 'The landlord activates. YieldFabric compiles the plan and stands up the property account, the send policy, and the rent obligation on-chain. The tenant then accepts the obligation to lock in the schedule.',
  },
  {
    n: 4,
    stage: 'Operate',
    who: 'everyone',
    what: 'The recurring rent loop (below). Each party can automate their side — the landlord auto-collects, the tenant auto-settles.',
  },
];

const WIRES: Array<{ surface: string; url: string; used: string }> = [
  {
    surface: 'Auth REST',
    url: 'auth.yieldfabric.com/auth/**, /protected/jwt',
    used: 'Sign-in, refresh, the group-delegation JWT (SDK) + identity lookup — src/lib/session.ts',
  },
  {
    surface: 'Federated gateway (DMS + reads)',
    url: 'api.yieldfabric.com/graphql',
    used: 'dealFlow { saveDealDraft · proposeDraft · signDeal · activateDeal · completePartyAction · automation } + reads — src/lib/dealFlow.ts',
  },
  {
    surface: 'Payments-direct (on-chain money loop)',
    url: 'pay.yieldfabric.com/graphql',
    used: 'accept · swapObligorPayment · completeSwap · data-policy ops — src/lib/payments.ts, src/lib/policy.ts',
  },
  {
    surface: 'Message status + balance',
    url: 'pay.yieldfabric.com/api/users/{eid}/messages/{mid}, /balance',
    used: 'Settlement polling + confidential balances — src/lib/graphql.ts',
  },
];

export default function Overview() {
  const { user } = useAuth();
  const [jwtInfo, setJwtInfo] = React.useState<JwtInfo | null>(null);
  const [jwtError, setJwtError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetchJwtInfo().then(setJwtInfo).catch((e: Error) => setJwtError(e.message));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-deep">
          How renting on YieldFabric works
        </h1>
        <p className="mt-2 text-sm text-ink-soft max-w-2xl leading-relaxed">
          A rental here isn’t a database row and a cron job — it’s a{' '}
          <strong className="font-semibold text-ink">signed agreement (a Deal)</strong> that the
          platform executes for you. You write the terms, the parties sign, you activate, and{' '}
          <a href={DOCS.dms} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
            YieldFabric’s deal-management system
          </a>{' '}
          stands up the on-chain pieces and runs the rent. This app walks through it; read a section,
          open the file, lift the pattern.
        </p>
      </div>

      {/* The three roles */}
      <section>
        <h2 className="text-sm font-semibold text-ink-deep mb-3">The three roles</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {ROLES.map((r) => (
            <div key={r.title} className="card">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-deep">{r.title}</h3>
                <span className="mini-label">{r.tag}</span>
              </div>
              <p className="mt-2 text-xs text-ink-soft leading-relaxed">{r.what}</p>
            </div>
          ))}
        </div>
      </section>

      {/* The lifecycle */}
      <section className="card">
        <h2 className="text-sm font-semibold text-ink-deep mb-1">The lifecycle</h2>
        <p className="text-xs text-ink-soft mb-4">
          Every lease moves through the same four stages. The lease page shows you exactly where
          yours is and what your role does next.
        </p>
        <ol className="space-y-3">
          {LIFECYCLE.map((s, i) => (
            <li key={s.n} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="h-6 w-6 shrink-0 grid place-items-center rounded-full bg-brand-600 text-white text-[11px] font-semibold">
                  {s.n}
                </span>
                {i < LIFECYCLE.length - 1 && <span className="w-px flex-1 bg-line mt-1" aria-hidden />}
              </div>
              <div className="pb-1">
                <div className="text-sm font-medium text-ink-deep">
                  {s.stage} <span className="ml-1 mini-label">{s.who}</span>
                </div>
                <p className="mt-0.5 text-xs text-ink-soft leading-relaxed">{s.what}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* The money model */}
      <section className="card bg-surface-alt">
        <h2 className="text-sm font-semibold text-ink-deep mb-1">How the money moves</h2>
        <p className="text-xs text-ink-soft leading-relaxed">
          Rent doesn’t jump straight to cash — the bit worth understanding. Each due payment goes:
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {[
            ['Scheduled', 'locked until its due date'],
            ['Due', 'unlocked, ready to collect'],
            ['Credited', 'landlord collected it — owed as tenant credit'],
            ['Exchanged', 'landlord turns credit into a cash swap'],
            ['Settled', 'tenant pays cash → property account'],
          ].map(([label, sub], i, arr) => (
            <React.Fragment key={label}>
              <span className="inline-flex flex-col rounded-md border border-line bg-white px-2.5 py-1">
                <span className="font-medium text-ink">{label}</span>
                <span className="text-[10px] text-ink-mute">{sub}</span>
              </span>
              {i < arr.length - 1 && <span className="text-ink-mute">→</span>}
            </React.Fragment>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-ink-mute leading-relaxed">
          <strong className="text-ink-soft">“Credited” ≠ “paid.”</strong> When the landlord collects
          rent it becomes <em>credit</em> — the tenant owes it, but no cash has moved. Cash only
          moves at settlement, after which the managing agent can disburse it within the policy.
        </p>
      </section>

      {/* Loans, too */}
      <section className="card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-ink-deep">Loans, too — the same pattern</h2>
          <span className="mini-label">periodic deal</span>
        </div>
        <p className="text-xs text-ink-soft leading-relaxed">
          A loan is the same idea — a signed Deal the platform runs — with two additions a rental
          doesn’t need. The <strong className="text-ink">lender</strong> disburses the principal up
          front; the <strong className="text-ink">borrower</strong> repays over a term, and the
          platform <em>amortizes</em> each payment into interest + principal via a{' '}
          <code className="bg-surface-alt px-1 rounded">cashflow</code> engine
          (<code className="bg-surface-alt px-1 rounded">amortizing_loan</code>) — advancing one
          period at a time. The loan note is a transferable NFT, so the loan can even be{' '}
          <em>sold</em>. Same lifecycle (Compose → Sign-off → Live → repay), loan-worded roles.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link to="/loan" className="btn-primary !py-1.5 text-xs">
            Compose a loan →
          </Link>
          <Link to="/loans" className="btn-secondary !py-1.5 text-xs">
            View loans
          </Link>
        </div>
      </section>

      {/* Your session */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-deep">Your session</h2>
          <span className="mini-label">GET /protected/jwt</span>
        </div>
        {jwtError && <p className="text-xs text-status-error-text">{jwtError}</p>}
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="mini-label">Signed in as</dt>
            <dd className="text-ink mt-0.5 truncate">{user?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="mini-label">Entity id (your party id)</dt>
            <dd className="text-ink mt-0.5 font-mono text-xs break-all">{user?.id ?? '…'}</dd>
          </div>
          <div>
            <dt className="mini-label">Smart-account address</dt>
            <dd className="text-ink mt-0.5 font-mono text-xs break-all">{jwtInfo?.account_address ?? '…'}</dd>
          </div>
        </dl>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link to="/lease" className="btn-primary">
          Compose a rental →
        </Link>
        <Link to="/leases" className="btn-secondary">
          View leases
        </Link>
        <Link to="/wallet" className="btn-secondary">
          Your wallet
        </Link>
      </div>

      {/* Under the hood — for developers */}
      <details className="card">
        <summary className="text-sm font-semibold text-ink-deep cursor-pointer">
          Under the hood — for developers
        </summary>
        <p className="mt-3 text-xs text-ink-soft">
          A consumer app talks to a small, fixed set of YieldFabric surfaces. The DMS deal lifecycle
          and cross-service reads ride the federated gateway; the on-chain money loop goes
          payments-direct; settlement is confirmed by polling the message-status endpoint. Full
          rules:{' '}
          <a href={DOCS.buildingWithYf} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
            building with YF ↗
          </a>
          .
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="mini-label pb-2 pr-4">Surface</th>
                <th className="mini-label pb-2 pr-4">URL</th>
                <th className="mini-label pb-2">Used by</th>
              </tr>
            </thead>
            <tbody>
              {WIRES.map((w) => (
                <tr key={w.surface} className="border-b border-line-soft last:border-0 align-top">
                  <td className="py-2 pr-4 font-medium text-ink whitespace-nowrap">{w.surface}</td>
                  <td className="py-2 pr-4 font-mono text-[11px] text-ink-soft whitespace-nowrap">
                    {w.url}
                  </td>
                  <td className="py-2 text-ink-soft">{w.used}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
